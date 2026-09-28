import type { Context } from "grammy";
import { getMainNavigationMessageId } from "../../app/stores/settings-store.js";

/**
 * Resolve the message a wizard flow should re-render: the bot's canonical Main
 * navigation panel when one is pinned for this chat, otherwise the message the
 * callback arrived on.
 *
 * Four command modules each carried their own copy of this. They had drifted:
 * only one validated that a stored panel id is a positive integer, so a corrupt
 * settings value could produce an invalid `editMessageText` target. The stricter
 * behaviour is kept here for every caller.
 */
export function callbackMessageId(ctx: Context): number | null {
  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id;
  if (typeof chatId === "number") {
    const canonical = getMainNavigationMessageId(chatId);
    if (typeof canonical === "number" && Number.isInteger(canonical) && canonical > 0) {
      return canonical;
    }
  }
  const message = ctx.callbackQuery?.message;
  if (!message || !("message_id" in message)) return null;
  return typeof message.message_id === "number" ? message.message_id : null;
}

/**
 * Delete the user's own message so a secret they pasted (token, API key, auth
 * code) disappears from the chat. Telegram may deny the delete; the failure is
 * swallowed because the flow must continue either way.
 */
export function deleteInputMessage(ctx: Context): Promise<unknown> {
  const messageId = ctx.message?.message_id;
  if (!ctx.chat?.id || !messageId) return Promise.resolve();
  return ctx.api.deleteMessage(ctx.chat.id, messageId).catch(() => undefined);
}

/** Escape a value for Telegram's HTML parse mode. */
export function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Re-render a view onto the canonical panel, tolerating Telegram's
 * "message is not modified" for an unchanged view.
 */
export async function editPanelMessage(
  ctx: Context,
  messageId: number,
  text: string,
  replyMarkup?: Parameters<Context["api"]["editMessageText"]>[2],
): Promise<void> {
  try {
    await ctx.api.editMessageText(ctx.chat!.id, messageId, text, replyMarkup);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/message is not modified/i.test(message)) throw error;
  }
}
