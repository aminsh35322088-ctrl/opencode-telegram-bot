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

const originalPromptAsync = baseClient.session.promptAsync.bind(baseClient.session);
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
  const result = await originalPromptAsync(promptOptions);
  logger.info(`[LLM Prompt] session=${options.sessionID} promptAsync returned in ${Date.now() - dispatchStartedAt}ms`);
  observePromptUsage(baseClient as never, { sessionId: options.sessionID, directory: options.directory, model, promptChars });
  return result;
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
