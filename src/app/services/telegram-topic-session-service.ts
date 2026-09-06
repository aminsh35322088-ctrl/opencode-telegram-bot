import type { Api } from "grammy";
import { logger } from "../../utils/logger.js";
import type { SessionInfo } from "../types/session.js";
import { findTelegramTopicBindingBySession, listTelegramTopicBindings, hasLegacyNavigationCleanupRun, markLegacyNavigationCleanupRun, saveTelegramTopicBinding, updateTelegramTopicBinding, type TelegramTopicBinding } from "./telegram-topic-store.js";

const OPEN_SESSION_LOCKS = new Map<string, Promise<TelegramTopicBinding>>();
function normalizeTopicTitle(title: string): string { const normalized = title.replace(/\s+/gu, " ").trim(); const codePoints = Array.from(normalized).slice(0, 128).join("").trim(); return codePoints || "New Chat"; }
async function createForumTopic(api: Api, chatId: number, title: string): Promise<number> { const result = await api.raw.createForumTopic({ chat_id: chatId, name: title }); if (!result.message_thread_id) throw new Error("Telegram created a topic without a message_thread_id"); return result.message_thread_id; }
async function persistNewBinding(chatId: number, session: SessionInfo, threadId: number): Promise<TelegramTopicBinding> { const now = new Date().toISOString(); const binding: TelegramTopicBinding = { chatId, threadId, sessionId: session.id, directory: session.directory, createdAt: now, updatedAt: now, title: session.title }; await saveTelegramTopicBinding(binding); return binding; }

/** Installs a pinned native Telegram reply back to the General message. */
export async function installNewTopicNavigation(api: Api, binding: TelegramTopicBinding, generalMessageId: number): Promise<void> {
  try {
    const message = await api.sendMessage(
      binding.chatId,
      "📌 Navigation\n\n↩️ Return to General",
      { message_thread_id: binding.threadId, reply_parameters: { message_id: generalMessageId, allow_sending_without_reply: true } },
    );
    await api.pinChatMessage(binding.chatId, message.message_id, { disable_notification: true });
    binding.navigationMessageId = message.message_id;
    await updateTelegramTopicBinding(binding.chatId, binding.threadId, { navigationMessageId: message.message_id });
    logger.info(`[TelegramTopics] Pinned native General reply navigation: chat=${binding.chatId}, thread=${binding.threadId}, message=${message.message_id}, generalMessage=${generalMessageId}`);
  } catch (error) {
    logger.warn(`[TelegramTopics] Failed to install native General navigation in thread=${binding.threadId}; topic remains usable`, error);
  }
}

/** Removes navigation messages created by the previous global migration, once. */
export async function cleanupLegacyTopicNavigationMessages(api: Api): Promise<void> {
  if (await hasLegacyNavigationCleanupRun()) return;
  const bindings = await listTelegramTopicBindings();
  const legacyBindings = bindings.filter((binding) => binding.navigationMessageId !== undefined);
  if (!legacyBindings.length) { await markLegacyNavigationCleanupRun(); return; }
  let failed = false;
  for (const binding of legacyBindings) {
    try {
      await api.deleteMessage(binding.chatId, binding.navigationMessageId!);
      await updateTelegramTopicBinding(binding.chatId, binding.threadId, { navigationMessageId: undefined });
      logger.info(`[TelegramTopics] Removed legacy navigation from thread=${binding.threadId}`);
    } catch (error) {
      failed = true;
      logger.warn(`[TelegramTopics] Failed to remove legacy navigation from thread=${binding.threadId}`, error);
    }
  }
  if (!failed) await markLegacyNavigationCleanupRun();
}

async function openSessionInTopicInternal(api: Api, chatId: number, session: SessionInfo): Promise<TelegramTopicBinding> {
  const existing = await findTelegramTopicBindingBySession(chatId, session.id);
  if (existing) return existing;
  const title = normalizeTopicTitle(session.title);
  const threadId = await createForumTopic(api, chatId, title);
  const binding = await persistNewBinding(chatId, session, threadId);
  logger.info(`[TelegramTopics] Created topic binding: session=${session.id}, chat=${chatId}, thread=${threadId}, title="${title}", directory=${session.directory}`);
  return binding;
}
export async function openSessionInTelegramTopic(api: Api, chatId: number, session: SessionInfo): Promise<TelegramTopicBinding> { const lockKey = `${chatId}:${session.id}`; const existing = OPEN_SESSION_LOCKS.get(lockKey); if (existing) return existing; const operation = openSessionInTopicInternal(api, chatId, session).finally(() => OPEN_SESSION_LOCKS.delete(lockKey)); OPEN_SESSION_LOCKS.set(lockKey, operation); return operation; }
export async function sendToTelegramTopic(api: Api, binding: TelegramTopicBinding, text: string): Promise<void> { for (const chunk of text.match(/.{1,4096}/su) ?? [text]) await api.sendMessage(binding.chatId, chunk, { message_thread_id: binding.threadId }); }
