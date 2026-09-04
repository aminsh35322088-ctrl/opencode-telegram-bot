import type { Api } from "grammy";
import { logger } from "../../utils/logger.js";
import type { SessionInfo } from "../types/session.js";
import {
  findTelegramTopicBindingBySession,
  saveTelegramTopicBinding,
  type TelegramTopicBinding,
} from "./telegram-topic-store.js";

const OPEN_SESSION_LOCKS = new Map<string, Promise<TelegramTopicBinding>>();

function normalizeTopicTitle(title: string): string {
  const normalized = title.replace(/\s+/gu, " ").trim();
  const codePoints = Array.from(normalized).slice(0, 128).join("").trim();
  return codePoints || "New Chat";
}

async function createForumTopic(api: Api, chatId: number, title: string): Promise<number> {
  const result = await api.raw.createForumTopic({
    chat_id: chatId,
    name: title,
  });

  if (!result.message_thread_id) {
    throw new Error("Telegram created a topic without a message_thread_id");
  }

  return result.message_thread_id;
}

async function persistNewBinding(
  chatId: number,
  session: SessionInfo,
  threadId: number,
): Promise<TelegramTopicBinding> {
  const binding: TelegramTopicBinding = {
    chatId,
    threadId,
    sessionId: session.id,
    directory: session.directory,
    createdAt: new Date().toISOString(),
    title: session.title,
  };
  await saveTelegramTopicBinding(binding);
  return binding;
}

async function openSessionInTopicInternal(
  api: Api,
  chatId: number,
  session: SessionInfo,
): Promise<TelegramTopicBinding> {
  const existing = await findTelegramTopicBindingBySession(chatId, session.id);
  if (existing) return existing;

  const title = normalizeTopicTitle(session.title);
  const threadId = await createForumTopic(api, chatId, title);
  const binding = await persistNewBinding(chatId, session, threadId);

  logger.info(
    `[TelegramTopics] Created topic binding: session=${session.id}, chat=${chatId}, thread=${threadId}, title="${title}", directory=${session.directory}`,
  );

  return binding;
}

/**
 * Creates exactly one Telegram Topic for an OpenCode session.
 * Each new session is expected to have its own isolated working directory;
 * Telegram only provides the topic/thread presentation and routing identity.
 */
export async function openSessionInTelegramTopic(
  api: Api,
  chatId: number,
  session: SessionInfo,
): Promise<TelegramTopicBinding> {
  const lockKey = `${chatId}:${session.id}`;
  const existing = OPEN_SESSION_LOCKS.get(lockKey);
  if (existing) return existing;

  const operation = openSessionInTopicInternal(api, chatId, session).finally(() => {
    OPEN_SESSION_LOCKS.delete(lockKey);
  });
  OPEN_SESSION_LOCKS.set(lockKey, operation);
  return operation;
}

export async function sendToTelegramTopic(
  api: Api,
  binding: TelegramTopicBinding,
  text: string,
): Promise<void> {
  for (const chunk of text.match(/.{1,4096}/su) ?? [text]) {
    await api.sendMessage(binding.chatId, chunk, {
      message_thread_id: binding.threadId,
    });
  }
}
