import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { config } from "../config.js";
import { formatMemoriesForPrompt, searchRelevantMemories } from "../app/services/memory-service.js";
import { observePromptUsage } from "../app/services/prompt-usage-observer.js";
import { logger } from "../utils/logger.js";

const getAuth = () => {
  if (!config.opencode.password) {
    return undefined;
  }
  const credentials = `${config.opencode.username}:${config.opencode.password}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
};

const baseClient = createOpencodeClient({
  baseUrl: config.opencode.apiUrl,
  headers: config.opencode.password ? { Authorization: getAuth() } : undefined,
});

type PromptPart = { type?: string; text?: string };
type PromptOptions = {
  sessionID: string;
  directory: string;
  parts: PromptPart[];
  model?: { providerID: string; modelID: string };
  agent?: string;
  variant?: string;
};

type SessionApi = typeof baseClient.session;

type EventLike = {
  type?: unknown;
  properties?: unknown;
};

const MEMORY_LOOKUP_BUDGET_MS = 75;

function extractPromptText(parts: PromptPart[]): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

function countPromptChars(parts: PromptPart[]): number {
  return parts.reduce((total, part) => total + (typeof part.text === "string" ? part.text.length : 0), 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getStringProperty(properties: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = properties[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function traceLifecycleEvent(event: EventLike): void {
  if (typeof event.type !== "string" || !isRecord(event.properties)) {
    return;
  }

  const properties = event.properties;
  const sessionId = getStringProperty(properties, "sessionID", "sessionId", "id") ?? "unknown";
  const status = getStringProperty(properties, "status");
  const partType = getStringProperty(properties, "type", "partType");
  const tool = getStringProperty(properties, "tool", "toolName");
  const callId = getStringProperty(properties, "callID", "callId");
  const messageId = getStringProperty(properties, "messageID", "messageId");
  const role = getStringProperty(properties, "role");
  const state = getStringProperty(properties, "state");

  const line =
    `[SessionLifecycle] event=${event.type} session=${sessionId}` +
    `${status ? ` status=${status}` : ""}` +
    `${state ? ` state=${state}` : ""}` +
    `${partType ? ` partType=${partType}` : ""}` +
    `${tool ? ` tool=${tool}` : ""}` +
    `${callId ? ` callId=${callId}` : ""}` +
    `${messageId ? ` messageId=${messageId}` : ""}` +
    `${role ? ` role=${role}` : ""}`;

  logger.debug(line);
}

async function searchMemoriesWithinBudget(options: {
  query: string;
  projectDirectory: string;
  maxChars: number;
}): Promise<Awaited<ReturnType<typeof searchRelevantMemories>>> {
  let timer: NodeJS.Timeout | undefined;
  const lookup = searchRelevantMemories(options);
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), MEMORY_LOOKUP_BUDGET_MS);
  });

  try {
    const startedAt = Date.now();
    const result = await Promise.race([lookup, timeout]);
    const elapsedMs = Date.now() - startedAt;
    if (result === null) {
      logger.debug(`[Memory] Lookup exceeded ${MEMORY_LOOKUP_BUDGET_MS}ms; sending prompt without memory`);
      return [];
    }

    logger.debug(`[Memory] Lookup completed in ${elapsedMs}ms; matches=${result.length}`);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const originalPromptAsync = baseClient.session.promptAsync.bind(baseClient.session);

async function instrumentedPromptAsync(options: PromptOptions): Promise<unknown> {
  const originalParts = Array.isArray(options.parts) ? options.parts : [];
  const userText = extractPromptText(originalParts);
  const model = options.model
    ? `${options.model.providerID}/${options.model.modelID}`
    : "default";

  const promptStart = Date.now();
  logger.info(
    `[SessionLifecycle] phase=prompt_start session=${options.sessionID} model=${model} agent=${options.agent ?? "default"} inputChars=${countPromptChars(originalParts)}`,
  );

  let parts = originalParts;
  if (userText) {
    try {
      const memories = await searchMemoriesWithinBudget({
        query: userText,
        projectDirectory: options.directory,
        maxChars: 2000,
      });
      const memoryText = formatMemoriesForPrompt(memories);
      if (memoryText) {
        parts = [{ type: "text", text: memoryText }, ...originalParts];
        logger.debug(
          `[Memory] Injecting ${memories.length} relevant memories into session=${options.sessionID} chars=${memoryText.length}`,
        );
      }
    } catch (error) {
      logger.warn("[Memory] Memory retrieval failed; continuing without memory:", error);
    }
  }

  const promptOptions = { ...options, parts } as Parameters<SessionApi["promptAsync"]>[0];
  const promptChars = countPromptChars(parts);

  logger.info(
    `[LLM Prompt] session=${options.sessionID} model=${model} agent=${options.agent ?? "default"} parts=${parts.length} promptChars=${promptChars} memoryInjected=${parts.length > originalParts.length} prepMs=${Date.now() - promptStart}`,
  );

  const dispatchStartedAt = Date.now();
  logger.info(`[SessionLifecycle] phase=prompt_dispatch_start session=${options.sessionID}`);
  try {
    const result = await originalPromptAsync(promptOptions);
    logger.info(
      `[SessionLifecycle] phase=prompt_dispatch_accepted session=${options.sessionID} elapsedMs=${Date.now() - dispatchStartedAt}`,
    );
    logger.info(`[LLM Prompt] session=${options.sessionID} promptAsync returned in ${Date.now() - dispatchStartedAt}ms`);

    observePromptUsage(baseClient as never, {
      sessionId: options.sessionID,
      directory: options.directory,
      model,
      promptChars,
    });

    return result;
  } catch (error) {
    logger.error(
      `[SessionLifecycle] phase=prompt_dispatch_error session=${options.sessionID} elapsedMs=${Date.now() - dispatchStartedAt}`,
      error,
    );
    throw error;
  }
}

const instrumentedSession = new Proxy(baseClient.session, {
  get(target, property, receiver) {
    if (property === "promptAsync") {
      return instrumentedPromptAsync;
    }
    return Reflect.get(target, property, receiver);
  },
});

const instrumentedGlobal = new Proxy(baseClient.global, {
  get(target, property, receiver) {
    if (property !== "event") {
      return Reflect.get(target, property, receiver);
    }

    const originalEvent = target.event.bind(target);
    return async (...args: Parameters<typeof target.event>) => {
      const result = await originalEvent(...args);
      if (!result.stream) {
        return result;
      }

      const originalStream = result.stream;
      async function* tracedStream(): AsyncGenerator<unknown, unknown, unknown> {
        try {
          while (true) {
            const next = await originalStream.next();
            if (next.done) {
              logger.info("[SessionLifecycle] phase=global_stream_done");
              return next.value;
            }

            traceLifecycleEvent(next.value as EventLike);
            yield next.value;
          }
        } catch (error) {
          logger.error("[SessionLifecycle] phase=global_stream_error", error);
          throw error;
        }
      }

      return { ...result, stream: tracedStream() };
    };
  },
});

export const opencodeClient = new Proxy(baseClient, {
  get(target, property, receiver) {
    if (property === "session") {
      return instrumentedSession;
    }
    if (property === "global") {
      return instrumentedGlobal;
    }
    return Reflect.get(target, property, receiver);
  },
});
