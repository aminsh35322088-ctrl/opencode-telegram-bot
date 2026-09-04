import type { Api } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { clearSession, getCurrentSession } from "./session-service.js";
import { removeTelegramTopicBinding, type TelegramTopicBinding } from "./telegram-topic-store.js";
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
  return /TOPIC_NOT_FOUND|topic.*not found|message thread.*not found/i.test(message);
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

  // Telegram deletion is the destructive boundary for the user-visible Topic.
  // Do it first so a Telegram API failure cannot leave an internally deleted
  // session/workspace that still appears to exist in Telegram.
  try {
    await api.deleteForumTopic(binding.chatId, binding.threadId);
  } catch (error) {
    if (!isAlreadyDeletedTopicError(error)) {
      topicTelemetry("telegram_topic_delete_failed", context);
      throw error;
    }
    logger.info(`[TelegramTopics] Telegram Topic already deleted: chat=${binding.chatId}, thread=${binding.threadId}`);
  }
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

  if (cleanupErrors.length > 0) {
    topicTelemetry("delete_completed_with_cleanup_errors", context, { cleanupErrors: cleanupErrors.length });
    throw new AggregateError(cleanupErrors, `Telegram Topic ${binding.threadId} was deleted, but ${cleanupErrors.length} local cleanup step(s) failed.`);
  }

  topicTelemetry("delete_completed", context);
  logger.info(`[TelegramTopics] Permanently deleted Topic: session=${binding.sessionId}, chat=${binding.chatId}, thread=${binding.threadId}, directory=${binding.directory}`);
}
