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

const originalPromptAsync = baseClient.session.promptAsync.bind(baseClient.session);

async function instrumentedPromptAsync(options: PromptOptions): Promise<unknown> {
  const originalParts = Array.isArray(options.parts) ? options.parts : [];
  const userText = extractPromptText(originalParts);
  const model = options.model
    ? `${options.model.providerID}/${options.model.modelID}`
    : "default";

  let parts = originalParts;
  try {
    if (userText) {
      const memories = await searchRelevantMemories({
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
    }
  } catch (error) {
    logger.warn("[Memory] Memory retrieval failed; continuing without memory:", error);
  }

  const promptOptions = { ...options, parts } as Parameters<SessionApi["promptAsync"]>[0];
  const promptChars = countPromptChars(parts);

  logger.info(
    `[LLM Prompt] session=${options.sessionID} model=${model} agent=${options.agent ?? "default"} parts=${parts.length} promptChars=${promptChars} memoryInjected=${parts.length > originalParts.length}`,
  );

  const result = await originalPromptAsync(promptOptions);

  observePromptUsage(baseClient as never, {
    sessionId: options.sessionID,
    directory: options.directory,
    model,
    promptChars,
  });

  return result;
}

const instrumentedSession = new Proxy(baseClient.session, {
  get(target, property, receiver) {
    if (property === "promptAsync") {
      return instrumentedPromptAsync;
    }
    return Reflect.get(target, property, receiver);
  },
});

export const opencodeClient = new Proxy(baseClient, {
  get(target, property, receiver) {
    if (property === "session") {
      return instrumentedSession;
    }
    return Reflect.get(target, property, receiver);
  },
});
