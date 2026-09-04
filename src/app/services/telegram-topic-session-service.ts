import type { Api } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { chunkPlainText } from "../../bot/render/chunker.js";
import { logger } from "../../utils/logger.js";
import type { SessionInfo } from "../types/session.js";
import {
  findTelegramTopicBindingBySession,
  saveTelegramTopicBinding,
  updateTelegramTopicBinding,
  type TelegramTopicBinding,
} from "./telegram-topic-store.js";

const MIGRATION_PAGE_SIZE = 1000;
const OPEN_SESSION_LOCKS = new Map<string, Promise<TelegramTopicBinding>>();

type SessionMessage = {
  info?: {
    role?: string;
    summary?: boolean;
  };
  parts?: Array<{
    type?: string;
    text?: string;
  }>;
};

function normalizeTopicTitle(title: string): string {
  const normalized = title.replace(/\s+/gu, " ").trim();
  const codePoints = Array.from(normalized).slice(0, 128).join("").trim();
  return codePoints || "New Chat";
}

function extractText(message: SessionMessage): string | null {
  const text = (message.parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("")
    .trim();
  return text || null;
}

function migrationLine(role: "user" | "assistant", text: string): string {
  return `${role === "user" ? "👤 You" : "🤖 Assistant"}\n${text}`;
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

async function verifyForumTopic(api: Api, chatId: number, threadId: number): Promise<boolean> {
  try {
    await api.raw.editForumTopic({
      chat_id: chatId,
      message_thread_id: threadId,
    });
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.debug(`[TelegramTopics] Topic verification failed: chat=${chatId} thread=${threadId} ${detail}`);
    return false;
  }
}

async function persistNewBinding(
  chatId: number,
  session: SessionInfo,
  threadId: number,
): Promise<TelegramTopicBinding> {
  const now = new Date().toISOString();
  const binding: TelegramTopicBinding = {
    chatId,
    threadId,
    sessionId: session.id,
    directory: session.directory,
    title: session.title,
    migrationStatus: "pending",
    migrationCursor: 0,
    createdAt: now,
    updatedAt: now,
  };
  await saveTelegramTopicBinding(binding);
  return binding;
}

async function migrateSessionMessages(api: Api, binding: TelegramTopicBinding): Promise<TelegramTopicBinding> {
  if (binding.migrationStatus === "completed") return binding;

  const started = await updateTelegramTopicBinding(binding, { migrationStatus: "migrating" });
  const response = await opencodeClient.session.messages({
    sessionID: started.sessionId,
    directory: started.directory,
    limit: MIGRATION_PAGE_SIZE,
  });

  if (response.error || !response.data) {
    throw response.error ?? new Error("OpenCode returned no session messages for migration");
  }

  const messages = (response.data as unknown as SessionMessage[])
    .filter((message) => message.info?.role === "user" || message.info?.role === "assistant")
    .filter((message) => !(message.info?.role === "assistant" && message.info?.summary))
    .map((message) => {
      const text = extractText(message);
      if (!text) return null;
      return migrationLine(message.info?.role === "user" ? "user" : "assistant", text);
    })
    .filter((value): value is string => value !== null);

  let cursor = Math.max(0, started.migrationCursor);
  for (; cursor < messages.length; cursor += 1) {
    const chunks = chunkPlainText(messages[cursor]);
    for (const chunk of chunks) {
      await api.sendMessage(binding.chatId, chunk.fallbackText, {
        message_thread_id: binding.threadId,
        disable_notification: true,
      });
    }

    binding.migrationCursor = cursor + 1;
    await updateTelegramTopicBinding(binding, {
      migrationStatus: "migrating",
      migrationCursor: binding.migrationCursor,
    });
  }

  if (messages.length >= MIGRATION_PAGE_SIZE) {
    logger.warn(
      `[TelegramTopics] Session migration reached the safety limit of ${MIGRATION_PAGE_SIZE} messages: session=${binding.sessionId}`,
    );
  }

  return updateTelegramTopicBinding(binding, {
    migrationStatus: "completed",
    migrationCursor: messages.length,
    migratedAt: new Date().toISOString(),
  });
}

async function openSessionInTopicInternal(
  api: Api,
  chatId: number,
  session: SessionInfo,
): Promise<TelegramTopicBinding> {
  let binding = await findTelegramTopicBindingBySession(chatId, session.id);

  if (binding && !(await verifyForumTopic(api, chatId, binding.threadId))) {
    logger.warn(
      `[TelegramTopics] Stored topic is no longer available; creating a replacement: session=${session.id}, oldThread=${binding.threadId}`,
    );
    binding = null;
  }

  if (!binding) {
    const title = normalizeTopicTitle(session.title);
    const threadId = await createForumTopic(api, chatId, title);
    binding = await persistNewBinding(chatId, session, threadId);
    logger.info(
      `[TelegramTopics] Created topic binding: session=${session.id}, chat=${chatId}, thread=${threadId}, title="${title}"`,
    );
  }

  try {
    binding = await migrateSessionMessages(api, binding);
  } catch (error) {
    await updateTelegramTopicBinding(binding, { migrationStatus: "failed" }).catch(() => {});
    throw error;
  }

  return binding;
}

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
  for (const chunk of chunkPlainText(text)) {
    await api.sendMessage(binding.chatId, chunk.fallbackText, {
      message_thread_id: binding.threadId,
    });
  }
}
