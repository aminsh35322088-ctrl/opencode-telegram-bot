import type { Api } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { clearSession } from "./session-service.js";
import { removeTelegramTopicBinding, type TelegramTopicBinding } from "./telegram-topic-store.js";
import { deleteTelegramTopicWorkspace, isTelegramTopicWorkspace } from "./telegram-topic-workspace-service.js";
import { logger } from "../../utils/logger.js";

export async function deleteTelegramTopicSession(
  api: Api,
  binding: TelegramTopicBinding,
): Promise<void> {
  if (!isTelegramTopicWorkspace(binding.directory)) {
    throw new Error(`Refusing to delete topic session with unmanaged directory: ${binding.directory}`);
  }

  const { data, error } = await opencodeClient.session.delete({
    sessionID: binding.sessionId,
    directory: binding.directory,
  });

  if (error) {
    throw error;
  }

  if (data !== true) {
    throw new Error(`OpenCode did not confirm deletion of session ${binding.sessionId}`);
  }

  await deleteTelegramTopicWorkspace(binding.directory);

  // Telegram deletion is deliberately last: if local cleanup fails, the
  // topic remains available so the cleanup can be retried instead of leaving
  // an apparently deleted chat with orphaned local data.
  await api.deleteForumTopic(binding.chatId, binding.threadId);
  await removeTelegramTopicBinding(binding.chatId, binding.sessionId);

  if (clearSessionMatches(binding)) {
    clearSession();
  }

  logger.info(
    `[TelegramTopics] Permanently deleted topic session: session=${binding.sessionId}, chat=${binding.chatId}, thread=${binding.threadId}, directory=${binding.directory}`,
  );
}

function clearSessionMatches(binding: TelegramTopicBinding): boolean {
  // The settings store is intentionally cleared by the caller when the
  // deleted session is the active one. This helper exists to keep the service
  // side-effect explicit and testable.
  return false;
}
