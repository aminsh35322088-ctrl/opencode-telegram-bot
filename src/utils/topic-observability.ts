import { logger } from "./logger.js";

export interface TopicTelemetryContext {
  chatId?: number;
  threadId?: number;
  sessionId?: string;
  directory?: string;
}

function formatContext(context: TopicTelemetryContext): string {
  const fields = [
    context.chatId !== undefined ? `chat=${context.chatId}` : null,
    context.threadId !== undefined ? `thread=${context.threadId}` : null,
    context.sessionId ? `session=${context.sessionId}` : null,
    context.directory ? `directory=${context.directory}` : null,
  ].filter((value): value is string => value !== null);
  return fields.join(" ");
}

/**
 * Emits low-cardinality, grep-friendly Topic lifecycle telemetry.
 * Never pass provider/API secrets in fields.
 */
export function topicTelemetry(
  event: string,
  context: TopicTelemetryContext = {},
  fields: Record<string, string | number | boolean | undefined> = {},
): void {
  const extras = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  const suffix = [formatContext(context), extras].filter(Boolean).join(" ");
  logger.info(`[TopicTelemetry] event=${event}${suffix ? ` ${suffix}` : ""}`);
}
