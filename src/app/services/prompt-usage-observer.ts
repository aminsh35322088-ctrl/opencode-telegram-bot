import { logger } from "../../utils/logger.js";

type UsageClient = {
  session: {
    status: (options: { directory: string }) => Promise<{ data?: unknown; error?: unknown }>;
    messages: (options: { sessionID: string; directory: string; limit?: number }) => Promise<{ data?: unknown; error?: unknown }>;
  };
};

type PromptUsageSnapshot = {
  input?: number | undefined;
  output?: number | undefined;
  reasoning?: number | undefined;
  cacheRead?: number | undefined;
  cacheWrite?: number | undefined;
  total?: number | undefined;
  cost?: number | undefined;
};

const MAX_OBSERVE_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function getNumber(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function extractUsage(message: unknown): PromptUsageSnapshot | null {
  const messageRecord = asRecord(message);
  const info = asRecord(messageRecord?.info);
  if (!info) return null;

  const tokens = asRecord(info.tokens);
  const usage = asRecord(info.usage);
  const source = tokens ?? usage;
  if (!source) return null;

  return {
    input: getNumber(source, "input", "promptTokens", "prompt_tokens"),
    output: getNumber(source, "output", "completionTokens", "completion_tokens"),
    reasoning: getNumber(source, "reasoning", "reasoningTokens", "reasoning_tokens"),
    cacheRead: getNumber(source, "cacheRead", "cache_read"),
    cacheWrite: getNumber(source, "cacheWrite", "cache_write"),
    total: getNumber(source, "total", "totalTokens", "total_tokens"),
    cost: getNumber(info, "cost") ?? getNumber(source, "cost"),
  };
}

function formatUsage(usage: PromptUsageSnapshot): string {
  const fields = [
    ["input", usage.input],
    ["output", usage.output],
    ["reasoning", usage.reasoning],
    ["cacheRead", usage.cacheRead],
    ["cacheWrite", usage.cacheWrite],
    ["total", usage.total],
    ["cost", usage.cost],
  ].filter(([, value]) => value !== undefined);

  return fields.map(([name, value]) => `${name}=${value}`).join(" ");
}

function isBusyStatus(data: unknown, sessionId: string): boolean {
  const record = asRecord(data);
  const status = asRecord(record?.[sessionId]);
  return status?.type === "busy";
}

export function observePromptUsage(
  client: UsageClient,
  options: { sessionId: string; directory: string; model: string; promptChars: number },
): void {
  const startedAt = Date.now();

  void (async () => {
    let lastLoggedSignature = "";

    while (Date.now() - startedAt < MAX_OBSERVE_MS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

      try {
        const statusResponse = await client.session.status({ directory: options.directory });
        if (statusResponse.error) continue;

        if (isBusyStatus(statusResponse.data, options.sessionId)) continue;

        const response = await client.session.messages({
          sessionID: options.sessionId,
          directory: options.directory,
          limit: 20,
        });
        if (response.error || !Array.isArray(response.data)) return;

        const usages = response.data.map(extractUsage).filter((usage): usage is PromptUsageSnapshot => usage !== null);
        const usage = usages.at(-1);
        if (!usage) return;

        const signature = formatUsage(usage);
        if (signature === lastLoggedSignature) return;
        lastLoggedSignature = signature;

        logger.info(
          `[LLM Usage] session=${options.sessionId} model=${options.model} promptChars=${options.promptChars} elapsedMs=${Date.now() - startedAt} ${signature}`,
        );
        return;
      } catch (error) {
        logger.debug("[LLM Usage] Observation probe failed:", error);
      }
    }

    logger.warn(
      `[LLM Usage] Observation window expired: session=${options.sessionId} model=${options.model} elapsedMs=${Date.now() - startedAt}`,
    );
  })();
}
