import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { config } from "../config.js";
import { formatMemoriesForPrompt, searchRelevantMemories } from "../app/services/memory-service.js";
import { observePromptUsage } from "../app/services/prompt-usage-observer.js";
import { logger } from "../utils/logger.js";

const getAuth = () => {
  if (!config.opencode.password) return undefined;
  const credentials = `${config.opencode.username}:${config.opencode.password}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
};

const baseClient = createOpencodeClient({
  baseUrl: config.opencode.apiUrl,
  headers: config.opencode.password ? { Authorization: getAuth() } : undefined,
});

// prompt_async is a fire-and-forget endpoint and should return 204 immediately.
// A stalled HTTP response must never pin the Telegram update handler for minutes.
// Keep this timeout only on the dispatch client; normal status/messages/event calls
// must not inherit it because those operations can legitimately be long-lived.
const PROMPT_DISPATCH_TIMEOUT_MS = 15_000;
const promptDispatchFetch: typeof fetch = (input, init) =>
  fetch(input, {
    ...init,
    signal: AbortSignal.any([
      init?.signal ?? new AbortController().signal,
      AbortSignal.timeout(PROMPT_DISPATCH_TIMEOUT_MS),
    ]),
  });

const promptDispatchClient = createOpencodeClient({
  baseUrl: config.opencode.apiUrl,
  headers: config.opencode.password ? { Authorization: getAuth() } : undefined,
  fetch: promptDispatchFetch,
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
type SessionCreateOptions = Parameters<SessionApi["create"]>[0];

const MEMORY_LOOKUP_BUDGET_MS = 75;

function extractPromptText(parts: PromptPart[]): string {
  return parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text ?? "").join("\n").trim();
}

function countPromptChars(parts: PromptPart[]): number {
  return parts.reduce((total, part) => total + (typeof part.text === "string" ? part.text.length : 0), 0);
}

async function searchMemoriesWithinBudget(options: { query: string; projectDirectory: string; maxChars: number }): Promise<Awaited<ReturnType<typeof searchRelevantMemories>>> {
  let timer: NodeJS.Timeout | undefined;
  const lookup = searchRelevantMemories(options);
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), MEMORY_LOOKUP_BUDGET_MS); });
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

const originalPromptAsync = promptDispatchClient.session.promptAsync.bind(promptDispatchClient.session);
const originalSessionCreate = baseClient.session.create.bind(baseClient.session);

async function instrumentedPromptAsync(options: PromptOptions): Promise<unknown> {
  const originalParts = Array.isArray(options.parts) ? options.parts : [];
  const userText = extractPromptText(originalParts);
  const model = options.model ? `${options.model.providerID}/${options.model.modelID}` : "default";
  const promptStart = Date.now();
  let parts = originalParts;
  if (userText) {
    try {
      const memories = await searchMemoriesWithinBudget({ query: userText, projectDirectory: options.directory, maxChars: 2000 });
      const memoryText = formatMemoriesForPrompt(memories);
      if (memoryText) {
        parts = [{ type: "text", text: memoryText }, ...originalParts];
        logger.debug(`[Memory] Injecting ${memories.length} relevant memories into session=${options.sessionID} chars=${memoryText.length}`);
      }
    } catch (error) {
      logger.warn("[Memory] Memory retrieval failed; continuing without memory:", error);
    }
  }
  const promptOptions = { ...options, parts } as Parameters<SessionApi["promptAsync"]>[0];
  const promptChars = countPromptChars(parts);
  logger.info(`[LLM Prompt] session=${options.sessionID} model=${model} agent=${options.agent ?? "default"} parts=${parts.length} promptChars=${promptChars} memoryInjected=${parts.length > originalParts.length} prepMs=${Date.now() - promptStart}`);
  const dispatchStartedAt = Date.now();
  try {
    const result = await originalPromptAsync(promptOptions);
    logger.info(`[LLM Prompt] session=${options.sessionID} promptAsync returned in ${Date.now() - dispatchStartedAt}ms`);
    observePromptUsage(baseClient as never, { sessionId: options.sessionID, directory: options.directory, model, promptChars });
    return result;
  } catch (error) {
    const elapsedMs = Date.now() - dispatchStartedAt;
    // If the HTTP transport timed out, determine whether OpenCode accepted the
    // prompt before surfacing an error. This prevents duplicate retries while
    // guaranteeing that a broken transport cannot leave Telegram waiting forever.
    if (elapsedMs >= PROMPT_DISPATCH_TIMEOUT_MS) {
      try {
        const status = await baseClient.session.status({ directory: options.directory });
        const statusRecord = status.data && typeof status.data === "object"
          ? (status.data as Record<string, unknown>)[options.sessionID]
          : undefined;
        const sessionStatus = statusRecord && typeof statusRecord === "object"
          ? (statusRecord as Record<string, unknown>).type
          : undefined;
        if (sessionStatus === "busy") {
          logger.warn(`[LLM Prompt] prompt_async transport timed out after ${elapsedMs}ms, but OpenCode reports session=${options.sessionID} busy; prompt was accepted and will continue`);
          observePromptUsage(baseClient as never, { sessionId: options.sessionID, directory: options.directory, model, promptChars });
          return undefined;
        }
      } catch (statusError) {
        logger.warn(`[LLM Prompt] Dispatch timed out after ${elapsedMs}ms and acceptance status could not be confirmed:`, statusError);
      }
    }
    logger.error(`[LLM Prompt] prompt_async dispatch failed after ${elapsedMs}ms:`, error);
    throw error;
  }
}

async function instrumentedSessionCreate(options: SessionCreateOptions): Promise<unknown> {
  try {
    const selectedModel = await import("../app/services/model-selection-service.js").then(({ fetchCurrentModel }) => fetchCurrentModel());
    if (selectedModel?.providerID && selectedModel?.modelID && options && typeof options === "object") {
      const createOptions = options as Record<string, unknown>;
      const existingBody = createOptions.body;
      const body = existingBody && typeof existingBody === "object" ? existingBody as Record<string, unknown> : {};
      if (!("model" in body)) {
        logger.info(`[OpenCode] Creating session pinned to selected model: ${selectedModel.providerID}/${selectedModel.modelID}`);
        return originalSessionCreate({ ...createOptions, body: { ...body, model: { providerID: selectedModel.providerID, modelID: selectedModel.modelID } } } as SessionCreateOptions);
      }
    }
  } catch (error) {
    logger.debug("[OpenCode] Could not resolve selected model while creating session; using default session creation", error);
  }
  return originalSessionCreate(options);
}

const instrumentedSession = new Proxy(baseClient.session, {
  get(target, property, receiver) {
    if (property === "promptAsync") return instrumentedPromptAsync;
    if (property === "create") return instrumentedSessionCreate;
    return Reflect.get(target, property, receiver);
  },
});

export const opencodeClient = new Proxy(baseClient, {
  get(target, property, receiver) {
    if (property === "session") return instrumentedSession;
    return Reflect.get(target, property, receiver);
  },
});
