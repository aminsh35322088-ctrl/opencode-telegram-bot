import type { Api } from "grammy";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { logger } from "../../utils/logger.js";
import { getUnscopedTelegramApi } from "../services/telegram-topic-runtime.js";
import { createMainKeyboard } from "./main-reply-keyboard.js";

const carrierMessageIds = new Map<number, number>();
const activeChats = new Set<number>();

/**
 * Telegram does not emit an update when a user merely switches private bot
 * Topic tabs, and ReplyKeyboardMarkup is input/chat state rather than message-
 * local UI. Keep Main restoration explicit and independent from AI Topic UI.
 */
export function markMainReplyKeyboardStale(chatId: number): void {
  activeChats.delete(chatId);
}

/**
 * Re-apply the Main/All 2x2 Reply Keyboard through the unscoped API.
 *
 * The carrier is intentionally kept alive. Deleting it immediately after
 * sendMessage can race Telegram clients and leave the previous Topic keyboard
 * cached. A later successful sync retires only the previous bot-owned carrier.
 */
export async function syncMainReplyKeyboard(api: Api, chatId: number, force = false): Promise<void> {
  if (!force && activeChats.has(chatId)) return;

  const rawApi = getUnscopedTelegramApi(api);
  const previousMessageId = carrierMessageIds.get(chatId);
  const response = await rawApi.sendMessage(chatId, "⌨️", {
    disable_notification: true,
    reply_markup: createMainKeyboard(getStoredModel(), { isTopic: false }),
  });

  if (typeof response.message_thread_id === "number" && response.message_thread_id > 1) {
    await rawApi.deleteMessage(chatId, response.message_id).catch(() => {});
    throw new Error(`Main Reply Keyboard was routed into Topic ${response.message_thread_id}`);
  }

  carrierMessageIds.set(chatId, response.message_id);
  activeChats.add(chatId);

  if (previousMessageId && previousMessageId !== response.message_id) {
    await rawApi.deleteMessage(chatId, previousMessageId).catch((error) => {
      logger.debug(`[TelegramKeyboard] Could not retire previous Main Reply Keyboard carrier: chat=${chatId}, message=${previousMessageId}`, error);
    });
  }

  logger.info(`[TelegramKeyboard] Main Reply Keyboard synchronized in All/root: chat=${chatId}, carrier=${response.message_id}`);
}
