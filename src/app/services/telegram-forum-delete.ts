import type { Api } from "grammy";
import {logger} from "../../utils/logger.js";

function isAlreadyDeletedTopicError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /TOPIC_NOT_FOUND|TOPIC_ID_INVALID|topic.*not found|message thread.*not found|invalid topic id/i.test(message);
}

function getRetryAfterMs(error: unknown): number | null {
  const candidate = error as { parameters?: { retry_after?: unknown } };
  const parameterSeconds = candidate.parameters?.retry_after;
  if (typeof parameterSeconds === "number" && Number.isFinite(parameterSeconds) && parameterSeconds >= 0) {
    return Math.min(Math.max(parameterSeconds * 1000, 250), 15_000);
  }
  const message = error instanceof Error ? error.message : String(error);
  const match = /retry after (\d+)/i.exec(message);
  return match ? Math.min(Math.max(Number(match[1]) * 1000, 250), 15_000) : null;
}

export async function deleteForumTopicWithRetry(api: Api, chatId: number, threadId: number): Promise<void> {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await api.deleteForumTopic(chatId, threadId);
      return;
    } catch (error) {
      if (isAlreadyDeletedTopicError(error)) {
        logger.info(`[TelegramTopics] Telegram Topic already absent: chat=${chatId}, thread=${threadId}`);
        return;
      }
      const retryAfterMs = getRetryAfterMs(error);
      const message = error instanceof Error ? error.message : String(error);
      const isRateLimited = retryAfterMs !== null || /429|too many requests/i.test(message);
      if (!isRateLimited || attempt === maxAttempts) throw error;
      const delayMs = retryAfterMs ?? Math.min(1000 * attempt, 5000);
      logger.warn(`[TelegramTopics] Telegram Topic delete rate-limited: chat=${chatId}, thread=${threadId}, retrying in ${delayMs}ms (attempt ${attempt}/${maxAttempts})`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

