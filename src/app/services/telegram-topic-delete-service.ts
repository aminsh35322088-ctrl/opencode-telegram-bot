import type { Api } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { clearSession, getCurrentSession } from "./session-service.js";
import { detachAttachedSession } from "./attach-service.js";
import { removeTelegramTopicBinding, listTelegramTopicBindings, type TelegramTopicBinding } from "./telegram-topic-store.js";
import { deleteTelegramTopicWorkspace, isTelegramTopicWorkspace } from "./telegram-topic-workspace-service.js";
import { removeTopicRuntimeState } from "../stores/topic-runtime-state-store.js";
import { promptQueue } from "../managers/prompt-queue-manager.js";
import { promptAttachment } from "../managers/prompt-attachment-manager.js";
import { interactionManager } from "../managers/interaction-manager.js";
import { questionManager } from "../managers/question-manager.js";
import { permissionManager } from "../managers/permission-manager.js";
import { renameManager } from "../managers/rename-manager.js";
import { taskCreationManager } from "../managers/scheduled-task-creation-manager.js";
import { summaryAggregator } from "../managers/summary-aggregation-manager.js";
import { dropTopicScopedInstance } from "./topic-scoped-singleton.js";
import { keyboardManager } from "../../bot/keyboards/keyboard-manager.js";
import { stopTopicEventSubscription } from "../../opencode/events.js";
import { clearQueuedPromptContext } from "../../bot/handlers/prompt-queue-dispatch.js";
import { logger } from "../../utils/logger.js";
import { topicTelemetry } from "../../utils/topic-observability.js";
import { getTelegramTopicRuntimeDependencies } from "../../bot/services/telegram-topic-runtime.js";

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

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const candidate = error as {
      message?: unknown;
      name?: unknown;
      _tag?: unknown;
      status?: unknown;
      statusCode?: unknown;
      data?: { message?: unknown; name?: unknown; _tag?: unknown; status?: unknown };
      response?: { status?: unknown };
    };
    const message = candidate.message ?? candidate.data?.message;
    if (typeof message === "string" && message.trim()) return message;
    try { return JSON.stringify(error); } catch { /* fall through */ }
  }
  return String(error);
}

export function isOpencodeSessionNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return /session.*not found|not found.*session/i.test(errorMessage(error));
  const candidate = error as {
    name?: unknown;
    _tag?: unknown;
    status?: unknown;
    statusCode?: unknown;
    data?: { message?: unknown; name?: unknown; _tag?: unknown; status?: unknown };
    response?: { status?: unknown };
  };
  const status = candidate.status ?? candidate.statusCode ?? candidate.data?.status ?? candidate.response?.status;
  if (status === 404) return true;
  const descriptor = [
    candidate.name,
    candidate._tag,
    candidate.data?.name,
    candidate.data?._tag,
    errorMessage(error),
  ].filter((value): value is string => typeof value === "string").join(" ");
  return /NotFoundError|SessionNotFound|session.*not found|not found.*session/i.test(descriptor);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorMessage(error));
}

export async function deleteTelegramTopicSession(api: Api, binding: TelegramTopicBinding): Promise<void> {
  const context = { chatId: binding.chatId, threadId: binding.threadId, sessionId: binding.sessionId, directory: binding.directory };
  topicTelemetry("delete_started", context);
  const cleanupErrors: Error[] = [];

  // The unmanaged-directory guard only protects the filesystem rm step. Binding,
  // runtime-state, session, and keyboard cleanup must always run, or a Topic
  // with a stale directory permanently refuses deletion and leaks workspace
  // state files on the volume.
  const managedWorkspace = isTelegramTopicWorkspace(binding.directory);
  if (!managedWorkspace) {
    topicTelemetry("delete_refused_unmanaged_workspace", context);
    logger.warn(`[TelegramTopics] Topic directory is not a managed workspace; skipping directory deletion: chat=${binding.chatId}, thread=${binding.threadId}, directory=${binding.directory}`);
    cleanupErrors.push(new Error(`Refused to delete unmanaged directory: ${binding.directory}`));
  }

  try {
    const { data, error } = await opencodeClient.session.delete({ sessionID: binding.sessionId, directory: binding.directory });
    if (error) {
      if (isOpencodeSessionNotFoundError(error)) {
        logger.info(`[TelegramTopics] OpenCode session already absent: session=${binding.sessionId}`);
        topicTelemetry("session_already_deleted", context);
      } else {
        throw asError(error);
      }
    } else if (data !== true) {
      throw new Error(`OpenCode did not confirm deletion of session ${binding.sessionId}`);
    } else {
      topicTelemetry("session_deleted", context);
    }
  } catch (error) {
    if (isOpencodeSessionNotFoundError(error)) {
      logger.info(`[TelegramTopics] OpenCode session already absent: session=${binding.sessionId}`);
      topicTelemetry("session_already_deleted", context);
    } else {
      const normalized = asError(error);
      cleanupErrors.push(normalized);
      logger.warn(`[TelegramTopics] Session cleanup failed; retaining Topic binding for retry: session=${binding.sessionId}`, error);
      topicTelemetry("session_delete_failed_binding_retained", context);
      throw new AggregateError(
        cleanupErrors,
        `Telegram Topic ${binding.threadId} cleanup stopped because OpenCode session deletion was not confirmed; binding retained for retry.`,
      );
    }
  }

  stopTopicEventSubscription(binding.directory, binding.sessionId);
  getTelegramTopicRuntimeDependencies()?.retireSessionRuntime(binding.sessionId, "topic_deleted");
  topicTelemetry("event_subscription_removed", context);

  if (getCurrentSession()?.id === binding.sessionId) {
    clearSession();
    detachAttachedSession("telegram_topic_deleted");
  }

  if (managedWorkspace) {
    try {
      await deleteTelegramTopicWorkspace(binding.directory);
      topicTelemetry("workspace_deleted", context);
    } catch (error) {
      cleanupErrors.push(asError(error));
      logger.error(`[TelegramTopics] Failed to delete managed Topic workspace; retaining Topic binding for retry: directory=${binding.directory}`, error);
      topicTelemetry("workspace_delete_failed_binding_retained", context);
      throw new AggregateError(
        cleanupErrors,
        `Telegram Topic ${binding.threadId} cleanup stopped because workspace deletion failed; binding retained for retry.`,
      );
    }
  }

  try {
    await deleteForumTopicWithRetry(api, binding.chatId, binding.threadId);
    topicTelemetry("telegram_topic_deleted", context);
  } catch (error) {
    cleanupErrors.push(asError(error));
    logger.warn(`[TelegramTopics] Telegram Topic delete failed; retaining binding for retry: chat=${binding.chatId}, thread=${binding.threadId}`, error);
    topicTelemetry("telegram_topic_delete_failed_binding_retained", context);
    throw new AggregateError(
      cleanupErrors,
      `Telegram Topic ${binding.threadId} cleanup stopped because Telegram deletion failed; binding retained for retry.`,
    );
  }

  promptQueue.clearSession(binding.sessionId, "telegram_topic_deleted");
  clearQueuedPromptContext(binding.sessionId);
  promptAttachment.clearSession(binding.sessionId, "telegram_topic_deleted");
  keyboardManager.clearSession(binding.sessionId);
  const topicScopeKey = `${binding.chatId}:${binding.threadId}`;
  interactionManager.clearSession(topicScopeKey);
  questionManager.clearSession(topicScopeKey);
  permissionManager.clearSession(topicScopeKey);
  renameManager.clearSession(topicScopeKey);
  taskCreationManager.clearSession(topicScopeKey);
  dropTopicScopedInstance(summaryAggregator, topicScopeKey);
  topicTelemetry("ephemeral_state_cleared", context);

  try {
    await removeTopicRuntimeState(binding.chatId, binding.threadId);
    topicTelemetry("runtime_state_removed", context);
  } catch (error) {
    cleanupErrors.push(asError(error));
    logger.error(`[TelegramTopics] Failed to remove Topic runtime state; retaining binding for retry: chat=${binding.chatId}, thread=${binding.threadId}`, error);
    throw new AggregateError(
      cleanupErrors,
      `Telegram Topic ${binding.threadId} cleanup stopped because runtime-state removal failed; binding retained for retry.`,
    );
  }

  try {
    await removeTelegramTopicBinding(binding.chatId, binding.sessionId);
    topicTelemetry("binding_removed", context);
  } catch (error) {
    cleanupErrors.push(asError(error));
    logger.error(`[TelegramTopics] Failed to remove Topic binding: chat=${binding.chatId}, session=${binding.sessionId}`, error);
  }

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
