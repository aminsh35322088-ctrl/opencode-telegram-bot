import type { Api } from "grammy";
import { InlineKeyboard } from "grammy";
import { logger } from "../../utils/logger.js";
import type { SessionInfo } from "../types/session.js";
import { findTelegramTopicBindingBySession, listTelegramTopicBindings, saveTelegramTopicBinding, updateTelegramTopicBinding, type TelegramTopicBinding } from "./telegram-topic-store.js";
import { getMainTelegramThreadIdSync } from "./telegram-main-topic-store.js";

const OPEN_SESSION_LOCKS = new Map<string, Promise<TelegramTopicBinding>>();
function normalizeTopicTitle(title: string): string { const normalized = title.replace(/\s+/gu, " ").trim(); const codePoints = Array.from(normalized).slice(0, 128).join("").trim(); return codePoints || "New Chat"; }
function buildTelegramTopicLink(chatId: number, threadId: number): string { const id = String(chatId); const internalId = id.startsWith("-100") ? id.slice(4) : id.replace(/^-/, ""); return `https://t.me/c/${internalId}/${threadId}`; }
function buildGeneralTopicLink(chatId: number): string { return buildTelegramTopicLink(chatId, 1); }
async function createForumTopic(api: Api, chatId: number, title: string): Promise<number> { const result = await api.raw.createForumTopic({ chat_id: chatId, name: title }); if (!result.message_thread_id) throw new Error("Telegram created a topic without a message_thread_id"); return result.message_thread_id; }
async function persistNewBinding(chatId: number, session: SessionInfo, threadId: number): Promise<TelegramTopicBinding> { const now = new Date().toISOString(); const binding: TelegramTopicBinding = { chatId, threadId, sessionId: session.id, directory: session.directory, createdAt: now, updatedAt: now, title: session.title }; await saveTelegramTopicBinding(binding); return binding; }
export async function ensureTelegramTopicNavigationMessage(api: Api, binding: TelegramTopicBinding): Promise<boolean> {
  if (binding.navigationMessageId) return false;
  try {
    const message = await api.sendMessage(binding.chatId, "📌 Navigation\n\nUse this button to return to the General topic.", { message_thread_id: binding.threadId, reply_markup: new InlineKeyboard().url("↩️ Back to General", buildGeneralTopicLink(binding.chatId)) });
    await api.pinChatMessage(binding.chatId, message.message_id, { disable_notification: true });
    await updateTelegramTopicBinding(binding.chatId, binding.threadId, { navigationMessageId: message.message_id });
    logger.info(`[TelegramTopics] Pinned General navigation: chat=${binding.chatId}, thread=${binding.threadId}, message=${message.message_id}`);
    return true;
  } catch (error) {
    logger.warn(`[TelegramTopics] Failed to install General navigation in thread=${binding.threadId}; topic remains usable`, error);
    return false;
  }
}
export async function ensureTelegramTopicNavigationMessages(api: Api): Promise<void> {
  const bindings = await listTelegramTopicBindings();
  if (!bindings.length) return;
  logger.info(`[TelegramTopics] Ensuring General navigation in ${bindings.length} AI topic(s)`);
  const chatsWithNewNavigation = new Set<number>();
  for (const binding of bindings) if (await ensureTelegramTopicNavigationMessage(api, binding)) chatsWithNewNavigation.add(binding.chatId);
  // Installing migration messages updates the AI topics' last-message timestamps.
  // Restore General as the newest topic once, so the existing forum ordering keeps
  // General at the top. New topics install their navigation message before the
  // New Chat notification is sent to General, so future creations preserve this.
  for (const chatId of chatsWithNewNavigation) {
    const generalThreadId = getMainTelegramThreadIdSync(chatId);
    try {
      await api.sendMessage(chatId, "📌 General is the home topic for your OpenCode chats.", { ...(generalThreadId !== null ? { message_thread_id: generalThreadId } : {}) , disable_notification: true } as never);
      logger.info(`[TelegramTopics] Restored General to top after navigation migration: chat=${chatId}`);
    } catch (error) {
      logger.warn(`[TelegramTopics] Failed to restore General ordering after migration: chat=${chatId}`, error);
    }
  }
}
async function openSessionInTopicInternal(api: Api, chatId: number, session: SessionInfo): Promise<TelegramTopicBinding> { const existing = await findTelegramTopicBindingBySession(chatId, session.id); if (existing) { await ensureTelegramTopicNavigationMessage(api, existing); return existing; } const title = normalizeTopicTitle(session.title); const threadId = await createForumTopic(api, chatId, title); const binding = await persistNewBinding(chatId, session, threadId); await ensureTelegramTopicNavigationMessage(api, binding); logger.info(`[TelegramTopics] Created topic binding: session=${session.id}, chat=${chatId}, thread=${threadId}, title="${title}", directory=${session.directory}`); return binding; }
export async function openSessionInTelegramTopic(api: Api, chatId: number, session: SessionInfo): Promise<TelegramTopicBinding> { const lockKey = `${chatId}:${session.id}`; const existing = OPEN_SESSION_LOCKS.get(lockKey); if (existing) return existing; const operation = openSessionInTopicInternal(api, chatId, session).finally(() => OPEN_SESSION_LOCKS.delete(lockKey)); OPEN_SESSION_LOCKS.set(lockKey, operation); return operation; }
export async function sendToTelegramTopic(api: Api, binding: TelegramTopicBinding, text: string): Promise<void> { for (const chunk of text.match(/.{1,4096}/su) ?? [text]) await api.sendMessage(binding.chatId, chunk, { message_thread_id: binding.threadId }); }
