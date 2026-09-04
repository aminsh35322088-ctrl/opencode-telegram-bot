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

function isAlreadyDeletedTopicError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /TOPIC_NOT_FOUND|topic.*not found|message thread.*not found/i.test(message);
}

export async function deleteTelegramTopicSession(api: Api, binding: TelegramTopicBinding): Promise<void> {
  if (!isTelegramTopicWorkspace(binding.directory)) throw new Error(`Refusing to delete topic session with unmanaged directory: ${binding.directory}`);
  let sessionDeleteError: unknown = null;
  try {
    const { data, error } = await opencodeClient.session.delete({ sessionID: binding.sessionId, directory: binding.directory });
    if (error) sessionDeleteError = error;
    else if (data !== true) sessionDeleteError = new Error(`OpenCode did not confirm deletion of session ${binding.sessionId}`);
  } catch (error) { sessionDeleteError = error; }
  if (sessionDeleteError) logger.warn(`[TelegramTopics] Session cleanup returned an error; continuing with idempotent Topic cleanup: session=${binding.sessionId}`, sessionDeleteError);

  stopTopicEventSubscription(binding.directory, binding.sessionId);
  await deleteTelegramTopicWorkspace(binding.directory);

  try { await api.deleteForumTopic(binding.chatId, binding.threadId); }
  catch (error) { if (!isAlreadyDeletedTopicError(error)) throw error; logger.info(`[TelegramTopics] Telegram Topic already deleted: chat=${binding.chatId}, thread=${binding.threadId}`); }

  promptQueue.clearSession(binding.sessionId, "telegram_topic_deleted");
  promptAttachment.clearSession(binding.sessionId, "telegram_topic_deleted");
  keyboardManager.clearSession(binding.sessionId);
  interactionManager.clearSession(`${binding.chatId}:${binding.threadId}`);
  await removeTopicRuntimeState(binding.chatId, binding.threadId);
  await removeTelegramTopicBinding(binding.chatId, binding.sessionId);

  if (getCurrentSession()?.id === binding.sessionId) clearSession();
  logger.info(`[TelegramTopics] Permanently deleted Topic: session=${binding.sessionId}, chat=${binding.chatId}, thread=${binding.threadId}, directory=${binding.directory}`);
}
