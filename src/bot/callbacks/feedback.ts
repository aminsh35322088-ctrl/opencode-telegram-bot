import type { Context, Keyboard } from "grammy";
import type { I18nKey } from "../../i18n/en.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";

const CALLBACK_ANSWER_MAX_LENGTH = 200;
type FeedbackParams = Record<string, string | number | boolean | null | undefined>;

function resolveAnswerText(key: I18nKey, params?: FeedbackParams): string {
  const text = t(key, params);
  if (text.length <= CALLBACK_ANSWER_MAX_LENGTH) return text;
  logger.warn(`[Feedback] Callback answer truncated: key=${key}, length=${text.length}, limit=${CALLBACK_ANSWER_MAX_LENGTH}`);
  return text.slice(0, CALLBACK_ANSWER_MAX_LENGTH);
}

export async function notify(ctx: Context, key: I18nKey, params?: FeedbackParams): Promise<void> {
  await ctx.answerCallbackQuery({ text: resolveAnswerText(key, params) });
}

export async function alert(ctx: Context, key: I18nKey, params?: FeedbackParams): Promise<void> {
  await ctx.answerCallbackQuery({ text: resolveAnswerText(key, params), show_alert: true });
}

export async function failure(ctx: Context, key: I18nKey, params?: FeedbackParams): Promise<void> {
  await ctx.answerCallbackQuery({ text: resolveAnswerText(key, params) }).catch(() => {});
}

/** Send a new reply-keyboard message in the same Telegram Topic as the triggering callback. */
export async function switched(ctx: Context, text: string, keyboard: Keyboard): Promise<void> {
  await ctx.answerCallbackQuery();
  const callbackMessage = ctx.callbackQuery?.message;
  const threadId = callbackMessage && "message_thread_id" in callbackMessage
    ? (callbackMessage as { message_thread_id?: number }).message_thread_id
    : undefined;
  await ctx.reply(text, {
    reply_markup: keyboard,
    ...(typeof threadId === "number" ? { message_thread_id: threadId } : {}),
  } as never);
  await ctx.deleteMessage().catch(() => {});
}

export async function cancelMenu(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery({ text: resolveAnswerText("common.cancelled") }).catch(() => {});
  await ctx.deleteMessage().catch(() => {});
}

export async function cancelPrompt(ctx: Context, key: I18nKey): Promise<void> {
  await ctx.answerCallbackQuery({ text: resolveAnswerText("common.cancelled") }).catch(() => {});
  await ctx.editMessageText(t(key)).catch(() => {});
}
