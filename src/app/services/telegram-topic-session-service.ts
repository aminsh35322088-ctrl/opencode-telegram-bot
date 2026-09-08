import type { Api } from "grammy";
import type { SessionInfo } from "@opencode-ai/sdk";
import { logger } from "../../utils/logger.js";
import { createForumTopic, normalizeTopicTitle } from "../telegram/forum-topics.js";
import { findTelegramTopicBindingBySession, persistNewBinding } from "../telegram/topic-binding-store.js";
import type { TelegramTopicBinding } from "../telegram/topic-types.js";
import { getNextChatTitle } from "../telegram/topic-title.js";

const OPEN_SESSION_LOCKS = new Map<string, Promise<TelegramTopicBinding>>();
const CHAT_TOPIC_CREATION_LOCKS = new Map<number, Promise<void>>();

async function openSessionInTopicInternal(api: Api, chatId: number, session: SessionInfo): Promise<TelegramTopicBinding> {
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
  const chatOperation = previousChatOperation
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
