import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { assistantRunState } from "../../app/managers/assistant-run-state-manager.js";
import { findTelegramTopicBindingByThread } from "../../app/services/telegram-topic-store.js";
import { deleteTelegramTopicSession } from "../../app/services/telegram-topic-delete-service.js";
import { clearAllInteractionState } from "../../app/managers/interaction-manager.js";
import { getCurrentSession } from "../../app/services/session-service.js";
import { detachAttachedSession } from "../../app/services/attach-service.js";
import { logger } from "../../utils/logger.js";
import { MAIN_BUTTONS } from "../keyboards/main-reply-keyboard.js";

const DELETE_CALLBACK = "telegram-topic:delete";
const DELETE_CONFIRM_CALLBACK = `${DELETE_CALLBACK}:confirm`;
const DELETE_CANCEL_CALLBACK = `${DELETE_CALLBACK}:cancel`;

function getTopicFromMessage(ctx: Context): { chatId: number; threadId: number } | null {
  const message = ctx.message as
    | { chat?: { id?: number }; message_thread_id?: number; is_topic_message?: boolean }
    | undefined;
  if (
    typeof message?.chat?.id !== "number" ||
    typeof message.message_thread_id !== "number" ||
    !message.is_topic_message
  ) {
    return null;
  }
  return { chatId: message.chat.id, threadId: message.message_thread_id };
}

function getTopicFromCallback(ctx: Context): { chatId: number; threadId: number } | null {
  const message = ctx.callbackQuery?.message;
  const chatId = message?.chat?.id;
  const threadId = "message_thread_id" in (message ?? {})
    ? (message as { message_thread_id?: number }).message_thread_id
    : undefined;
  if (typeof chatId !== "number" || typeof threadId !== "number") return null;
  return { chatId, threadId };
}

export async function showTelegramTopicDeleteConfirmation(ctx: Context): Promise<void> {
  const topic = getTopicFromMessage(ctx);
  if (!topic) return;

  const binding = await findTelegramTopicBindingByThread(topic.chatId, topic.threadId);
  if (!binding) {
    await ctx.reply("❌ This Topic is not managed by the bot.");
    return;
  }

  if (assistantRunState.hasActiveRun(binding.sessionId)) {
    await ctx.reply("⏳ Please wait for the current task to finish before deleting this Chat.");
    return;
  }

  await ctx.reply(
    "⚠️ <b>Delete this Chat permanently?</b>\n\n" +
      "This removes the OpenCode session, its conversation memory, and the entire isolated working directory for this Topic.\n\n" +
      "The project/source directory outside this Topic will not be touched.\n\n" +
      "This action cannot be undone.",
    {
      parse_mode: "HTML",
      message_thread_id: topic.threadId,
      reply_markup: new InlineKeyboard()
        .text("🗑 Delete permanently", DELETE_CONFIRM_CALLBACK)
        .text("Cancel", DELETE_CANCEL_CALLBACK),
    } as never,
  );
}

export async function handleTelegramTopicDeleteCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (data !== DELETE_CONFIRM_CALLBACK && data !== DELETE_CANCEL_CALLBACK) return false;

  const topic = getTopicFromCallback(ctx);
  if (!topic) {
    await ctx.answerCallbackQuery({ text: "Topic context not found", show_alert: true }).catch(() => {});
    return true;
  }

  if (data === DELETE_CANCEL_CALLBACK) {
    await ctx.answerCallbackQuery({ text: "Deletion cancelled" }).catch(() => {});
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
    return true;
  }

  const binding = await findTelegramTopicBindingByThread(topic.chatId, topic.threadId);
  if (!binding) {
    await ctx.answerCallbackQuery({ text: "Topic is already deleted", show_alert: true }).catch(() => {});
    return true;
  }

  if (assistantRunState.hasActiveRun(binding.sessionId)) {
    await ctx.answerCallbackQuery({ text: "Finish the current task first", show_alert: true }).catch(() => {});
    return true;
  }

  const wasCurrentSession = getCurrentSession()?.id === binding.sessionId;

  try {
    await ctx.answerCallbackQuery({ text: "Deleting…" }).catch(() => {});
    await deleteTelegramTopicSession(ctx.api, binding);

    if (wasCurrentSession) {
      detachAttachedSession("telegram_topic_deleted");
      clearAllInteractionState("telegram_topic_deleted");
    }

    logger.info(
      `[TelegramTopics] Delete confirmation completed: session=${binding.sessionId}, thread=${binding.threadId}`,
    );
  } catch (error) {
    logger.error(
      `[TelegramTopics] Failed to permanently delete topic: session=${binding.sessionId}, thread=${binding.threadId}`,
      error,
    );
    await ctx.answerCallbackQuery({
      text: "Deletion failed. The Topic was kept so cleanup can be retried.",
      show_alert: true,
    }).catch(() => {});
    await ctx.editMessageText(
      "❌ <b>Chat deletion failed.</b>\n\nThe Topic was kept and no Telegram Topic deletion was performed. Please retry after fixing the reported error.",
      { parse_mode: "HTML" },
    ).catch(() => {});
  }

  return true;
}

export function registerTelegramTopicDeleteHandlers(bot: Bot<Context>): void {
  bot.hears(MAIN_BUTTONS.deleteChat, showTelegramTopicDeleteConfirmation);
  bot.callbackQuery(DELETE_CONFIRM_CALLBACK, handleTelegramTopicDeleteCallback);
  bot.callbackQuery(DELETE_CANCEL_CALLBACK, handleTelegramTopicDeleteCallback);
}
