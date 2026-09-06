import type { Api } from "grammy";
import { logger } from "../../utils/logger.js";
import type { SessionInfo } from "../types/session.js";
import { findTelegramTopicBindingBySession, saveTelegramTopicBinding, type TelegramTopicBinding } from "./telegram-topic-store.js";

const OPEN_SESSION_LOCKS = new Map<string, Promise<TelegramTopicBinding>>();
function normalizeTopicTitle(title: string): string { const normalized = title.replace(/\s+/gu, " ").trim(); const codePoints = Array.from(normalized).slice(0, 128).join("").trim(); return codePoints || "New Chat"; }
async function createForumTopic(api: Api, chatId: number, title: string): Promise<number> { const result = await api.raw.createForumTopic({ chat_id: chatId, name: title }); if (!result.message_thread_id) throw new Error("Telegram created a topic without a message_thread_id"); return result.message_thread_id; }
async function persistNewBinding(chatId: number, session: SessionInfo, threadId: number): Promise<TelegramTopicBinding> { const now = new Date().toISOString(); const binding: TelegramTopicBinding = { chatId, threadId, sessionId: session.id, directory: session.directory, createdAt: now, updatedAt: now, title: session.title }; await saveTelegramTopicBinding(binding); return binding; }

/**
 * Build a Telegram deep link that opens a specific topic in a private supergroup.
 * Format: https://t.me/c/<bareChatId>/<topicId>
 * The bare chat ID is the supergroup ID with the -100 prefix stripped.
 * For General topic, topicId = 1.
 */
function buildTopicDeepLink(chatId: number, topicId: number): string {
  const bareId = Math.abs(chatId).toString().replace(/^100/, "");
  return `https://t.me/c/${bareId}/${topicId}`;
}

/**
 * Pins a message in General with a button linking to the newly created topic.
 */
export async function pinNavigationInGeneral(api: Api, chatId: number, topicTitle: string, topicThreadId: number): Promise<void> {
  try {
    const url = buildTopicDeepLink(chatId, topicThreadId);
    const text = `🆕 New Topic Created\n\n💬 ${topicTitle}`;
    const msg = await api.sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [[{ text: "➡️ Open Topic", url }]],
      },
    });
    await api.pinChatMessage(chatId, msg.message_id, { disable_notification: true });
    logger.info(`[TelegramTopics] Pinned navigation in General: chat=${chatId}, topic="${topicTitle}", thread=${topicThreadId}`);
  } catch (error) {
    logger.warn(`[TelegramTopics] Failed to pin navigation in General: chat=${chatId}`, error);
  }
}

/**
 * Pins a message in an AI topic with a button linking back to General (thread 1).
 */
export async function installTopicNavigation(api: Api, chatId: number, threadId: number): Promise<void> {
  try {
    const url = buildTopicDeepLink(chatId, 1);
    const text = `📌 Navigation\n\n↩️ Return to General`;
    const msg = await api.sendMessage(chatId, text, {
      message_thread_id: threadId,
      reply_markup: {
        inline_keyboard: [[{ text: "↩️ Return to General", url }]],
      },
    });
    await api.pinChatMessage(chatId, msg.message_id, { disable_notification: true });
    logger.info(`[TelegramTopics] Pinned navigation in topic: chat=${chatId}, thread=${threadId}`);
  } catch (error) {
    logger.warn(`[TelegramTopics] Failed to pin navigation in topic: chat=${chatId}, thread=${threadId}`, error);
  }
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
