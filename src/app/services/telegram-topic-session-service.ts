import type { Api } from "grammy";
import { logger } from "../../utils/logger.js";
import type { SessionInfo } from "../types/session.js";
import { findTelegramTopicBindingBySession, listTelegramTopicBindings, saveTelegramTopicBinding, type TelegramTopicBinding } from "./telegram-topic-store.js";

const OPEN_SESSION_LOCKS = new Map<string, Promise<TelegramTopicBinding>>();
const CHAT_TOPIC_CREATION_LOCKS = new Map<number, Promise<void>>();
function normalizeTopicTitle(title: string): string { const normalized = title.replace(/\s+/gu, " ").trim(); const codePoints = Array.from(normalized).slice(0, 128).join("").trim(); return codePoints || "New Chat"; }
function formatChatTitle(number: number): string { return `Chat #${String(number).padStart(2, "0")}`; }
async function getNextChatTitle(chatId: number): Promise<string> {
  const bindings = (await listTelegramTopicBindings()).filter((binding) => binding.chatId === chatId);
  let maxNumber = 0;
  for (const binding of bindings) {
    const match = /^Chat #(\d+)$/u.exec(binding.title?.trim() ?? "");
    if (match) maxNumber = Math.max(maxNumber, Number(match[1]));
  }
  return formatChatTitle(maxNumber + 1);
}
async function createForumTopic(api: Api, chatId: number, title: string): Promise<number> { const result = await api.raw.createForumTopic({ chat_id: chatId, name: title }); if (!result.message_thread_id) throw new Error("Telegram created a topic without a message_thread_id"); return result.message_thread_id; }
async function persistNewBinding(chatId: number, session: SessionInfo, threadId: number, title: string): Promise<TelegramTopicBinding> { const now = new Date().toISOString(); const binding: TelegramTopicBinding = { chatId, threadId, sessionId: session.id, directory: session.directory, createdAt: now, updatedAt: now, title }; await saveTelegramTopicBinding(binding); return binding; }

async function openSessionInTopicInternal(api: Api, chatId: number, session: SessionInfo): Promise<TelegramTopicBinding> {
  const existing = await findTelegramTopicBindingBySession(chatId, session.id);
  if (existing) return existing;
  const title = await getNextChatTitle(chatId);
  const threadId = await createForumTopic(api, chatId, normalizeTopicTitle(title));
  const binding = await persistNewBinding(chatId, session, threadId, title);
  logger.info(`[TelegramTopics] Created topic binding: session=${session.id}, chat=${chatId}, thread=${threadId}, title="${title}", directory=${session.directory}`);
  return binding;
}

export async function openSessionInTelegramTopic(api: Api, chatId: number, session: SessionInfo): Promise<TelegramTopicBinding> {
  const lockKey = `${chatId}:${session.id}`;
  const existing = OPEN_SESSION_LOCKS.get(lockKey);
  if (existing) return existing;
  const previousChatOperation = CHAT_TOPIC_CREATION_LOCKS.get(chatId) ?? Promise.resolve();
  const chatOperation: Promise<void> = previousChatOperation
    .catch(() => {})
    .then(() => openSessionInTopicInternal(api, chatId, session).then(() => undefined))
    .finally(() => {
      if (CHAT_TOPIC_CREATION_LOCKS.get(chatId) === chatOperation) CHAT_TOPIC_CREATION_LOCKS.delete(chatId);
    });
  const operation = chatOperation.then(async () => {
    const created = await findTelegramTopicBindingBySession(chatId, session.id);
    if (!created) throw new Error(`Topic binding for session ${session.id} was not persisted`);
    return created;
  }).finally(() => OPEN_SESSION_LOCKS.delete(lockKey));
  OPEN_SESSION_LOCKS.set(lockKey, operation);
  CHAT_TOPIC_CREATION_LOCKS.set(chatId, chatOperation);
  return operation;
}
export async function sendToTelegramTopic(api: Api, binding: TelegramTopicBinding, text: string): Promise<void> { for (const chunk of text.match(/.{1,4096}/su) ?? [text]) await api.sendMessage(binding.chatId, chunk, { message_thread_id: binding.threadId }); }
