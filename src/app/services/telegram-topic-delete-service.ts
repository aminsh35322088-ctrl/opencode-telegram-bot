import type { Api } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { clearSession, getCurrentSession } from "./session-service.js";
import { removeTelegramTopicBinding, listTelegramTopicBindings, type TelegramTopicBinding } from "./telegram-topic-store.js";
import { deleteTelegramTopicWorkspace, isTelegramTopicWorkspace } from "./telegram-topic-workspace-service.js";
import { removeTopicRuntimeState } from "../stores/topic-runtime-state-store.js";
import { promptQueue } from "../managers/prompt-queue-manager.js";
import { promptAttachment } from "../managers/prompt-attachment-manager.js";
import { interactionManager } from "../managers/interaction-manager.js";
import { keyboardManager } from "../../bot/keyboards/keyboard-manager.js";
import { stopTopicEventSubscription } from "../../opencode/events.js";
import { logger } from "../../utils/logger.js";
import { topicTelemetry } from "../../utils/topic-observability.js";

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

async function deleteForumTopicWithRetry(api: Api, chatId: number, threadId: number): Promise<void> {
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

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export async function deleteTelegramTopicSession(api: Api, binding: TelegramTopicBinding): Promise<void> {
  const context = { chatId: binding.chatId, threadId: binding.threadId, sessionId: binding.sessionId, directory: binding.directory };
  topicTelemetry("delete_started", context);
  if (!isTelegramTopicWorkspace(binding.directory)) {
    topicTelemetry("delete_refused_unmanaged_workspace", context);
    throw new Error(`Refusing to delete topic session with unmanaged directory: ${binding.directory}`);
  }

  // Telegram Topic deletion is intentionally idempotent and retryable. A stale
  // binding can point at a Topic that was already deleted manually, while a
  // factory reset can legitimately delete several Topics in quick succession.
  await deleteForumTopicWithRetry(api, binding.chatId, binding.threadId);
  topicTelemetry("telegram_topic_deleted", context);

  const cleanupErrors: Error[] = [];

  try {
    const { data, error } = await opencodeClient.session.delete({ sessionID: binding.sessionId, directory: binding.directory });
    if (error) {
      cleanupErrors.push(asError(error));
      logger.warn(`[TelegramTopics] Session cleanup returned an error; continuing with idempotent Topic cleanup: session=${binding.sessionId}`, error);
      topicTelemetry("session_delete_failed_but_cleanup_continues", context);
    } else if (data !== true) {
      const error = new Error(`OpenCode did not confirm deletion of session ${binding.sessionId}`);
      cleanupErrors.push(error);
      logger.warn(`[TelegramTopics] OpenCode did not confirm session deletion: session=${binding.sessionId}`);
      topicTelemetry("session_delete_failed_but_cleanup_continues", context);
    } else {
      topicTelemetry("session_deleted", context);
    }
  } catch (error) {
    cleanupErrors.push(asError(error));
    logger.warn(`[TelegramTopics] Session cleanup threw; continuing with idempotent Topic cleanup: session=${binding.sessionId}`, error);
    topicTelemetry("session_delete_failed_but_cleanup_continues", context);
  }

  stopTopicEventSubscription(binding.directory, binding.sessionId);
  topicTelemetry("event_subscription_removed", context);

  try {
    await deleteTelegramTopicWorkspace(binding.directory);
    topicTelemetry("workspace_deleted", context);
  } catch (error) {
    cleanupErrors.push(asError(error));
    logger.error(`[TelegramTopics] Failed to delete managed Topic workspace: directory=${binding.directory}`, error);
    topicTelemetry("workspace_delete_failed", context);
  }

  promptQueue.clearSession(binding.sessionId, "telegram_topic_deleted");
  promptAttachment.clearSession(binding.sessionId, "telegram_topic_deleted");
  keyboardManager.clearSession(binding.sessionId);
  interactionManager.clearSession(`${binding.chatId}:${binding.threadId}`);
  topicTelemetry("ephemeral_state_cleared", context);

  try {
    await removeTopicRuntimeState(binding.chatId, binding.threadId);
    topicTelemetry("runtime_state_removed", context);
  } catch (error) {
    cleanupErrors.push(asError(error));
    logger.error(`[TelegramTopics] Failed to remove Topic runtime state: chat=${binding.chatId}, thread=${binding.threadId}`, error);
  }

  try {
    await removeTelegramTopicBinding(binding.chatId, binding.sessionId);
    topicTelemetry("binding_removed", context);
  } catch (error) {
    cleanupErrors.push(asError(error));
    logger.error(`[TelegramTopics] Failed to remove Topic binding: chat=${binding.chatId}, session=${binding.sessionId}`, error);
  }

  if (getCurrentSession()?.id === binding.sessionId) clearSession();

  const remainingBindings = (await listTelegramTopicBindings()).filter((b) => b.chatId === binding.chatId);
  if (remainingBindings.length === 0) {
    logger.info(`[TelegramTopics] No topics remaining for chat=${binding.chatId}; returning to normal mode`);
    keyboardManager.initialize(api, binding.chatId);
    await keyboardManager.sendKeyboardUpdate(binding.chatId, true).catch((err) => {
      logger.warn("[TelegramTopics] Failed to send main keyboard after returning to normal mode:", err);
    });
  }

  if (cleanupErrors.length > 0) {
    topicTelemetry("delete_completed_with_cleanup_errors", context, { cleanupErrors: cleanupErrors.length });
    throw new AggregateError(cleanupErrors, `Telegram Topic ${binding.threadId} was deleted, but ${cleanupErrors.length} local cleanup step(s) failed.`);
  }

  topicTelemetry("delete_completed", context);
  logger.info(`[TelegramTopics] Permanently deleted Topic: session=${binding.sessionId}, chat=${binding.chatId}, thread=${binding.threadId}, directory=${binding.directory}`);
}
