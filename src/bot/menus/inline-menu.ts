import { Context, InlineKeyboard } from "grammy";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import type { InteractionMetadata, InteractionState } from "../../app/types/interaction.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";

export const INLINE_MENU_CANCEL_PREFIX = "inline:cancel:";
export const LEGACY_CONTEXT_CANCEL_CALLBACK = "compact:cancel";

const INLINE_MENU_KINDS = ["session", "model", "agent", "variant", "context", "open", "ls", "worktree", "settings"] as const;
export type InlineMenuKind = (typeof INLINE_MENU_KINDS)[number];

interface ActiveInlineMenuMetadata { menuKind: InlineMenuKind; messageId: number; }
interface InlineMenuReplyOptions { menuKind: InlineMenuKind; text: string; keyboard: InlineKeyboard; parseMode?: "Markdown" | "HTML"; metadata?: InteractionMetadata; }

const activeInlineMenus = new Map<number, ActiveInlineMenuMetadata>();

export function isInlineMenuKind(value: string): value is InlineMenuKind { return INLINE_MENU_KINDS.includes(value as InlineMenuKind); }
function getCallbackMessageId(ctx: Context): number | null { const message = ctx.callbackQuery?.message; if (!message || !("message_id" in message)) return null; const id = (message as { message_id?: number }).message_id; return typeof id === "number" ? id : null; }
function getChatId(ctx: Context): number | null { return typeof ctx.chat?.id === "number" ? ctx.chat.id : null; }
function getTopicThreadId(ctx: Context): number | null {
  const message = (ctx.message ?? ctx.callbackQuery?.message) as { message_thread_id?: number } | undefined;
  return typeof message?.message_thread_id === "number" ? message.message_thread_id : null;
}
function getActiveInlineMenuMetadata(state: InteractionState | null): ActiveInlineMenuMetadata | null {
  if (!state || state.kind !== "inline") return null;
  const menuKind = state.metadata.menuKind; const messageId = state.metadata.messageId;
  if (typeof menuKind !== "string" || !isInlineMenuKind(menuKind) || typeof messageId !== "number") return null;
  return { menuKind, messageId };
}
function getInlineCancelCallbackData(menuKind: InlineMenuKind): string { return `${INLINE_MENU_CANCEL_PREFIX}${menuKind}`; }

export function appendInlineMenuCancelButton(keyboard: InlineKeyboard, menuKind: InlineMenuKind): InlineKeyboard {
  while (keyboard.inline_keyboard.length > 0) { const lastRow = keyboard.inline_keyboard[keyboard.inline_keyboard.length - 1]; if (!lastRow || lastRow.length > 0) break; keyboard.inline_keyboard.pop(); }
  if (keyboard.inline_keyboard.length > 0) keyboard.row();
  keyboard.text(menuKind === "settings" ? t("inline.button.close") : t("inline.button.cancel"), getInlineCancelCallbackData(menuKind));
  return keyboard;
}

export async function replyWithInlineMenu(ctx: Context, options: InlineMenuReplyOptions): Promise<number> {
  const keyboard = appendInlineMenuCancelButton(options.keyboard, options.menuKind);
  const replyOptions: { reply_markup: InlineKeyboard; parse_mode?: "Markdown" | "HTML" } = { reply_markup: keyboard };
  if (options.parseMode) replyOptions.parse_mode = options.parseMode;

  let messageId: number;
  const callbackMessageId = getCallbackMessageId(ctx);
  if (callbackMessageId !== null && ctx.chat?.id) {
    try {
      await ctx.api.editMessageText(ctx.chat.id, callbackMessageId, options.text, replyOptions);
      messageId = callbackMessageId;
    } catch (error) {
      logger.debug("[InlineMenu] Could not edit callback message; falling back to reply", error);
      const topicThreadId = getTopicThreadId(ctx);
      const message = await ctx.reply(options.text, {
        ...replyOptions,
        ...(topicThreadId !== null ? { message_thread_id: topicThreadId } : {}),
      } as never);
      messageId = message.message_id;
    }
  } else {
    const topicThreadId = getTopicThreadId(ctx);
    const message = await ctx.reply(options.text, {
      ...replyOptions,
      ...(topicThreadId !== null ? { message_thread_id: topicThreadId } : {}),
    } as never);
    messageId = message.message_id;
  }

  const chatId = getChatId(ctx);
  if (chatId !== null) activeInlineMenus.set(chatId, { menuKind: options.menuKind, messageId });
  interactionManager.start({ kind: "inline", expectedInput: "callback", metadata: { ...options.metadata, menuKind: options.menuKind, messageId, ...(chatId !== null ? { chatId } : {}) } });
  logger.debug(`[InlineMenu] Opened/updated menu: kind=${options.menuKind}, messageId=${messageId}, chatId=${chatId ?? "none"}`);
  return messageId;
}

export async function ensureActiveInlineMenu(ctx: Context, menuKind: InlineMenuKind): Promise<boolean> {
  const chatId = getChatId(ctx);
  const activeMetadata = chatId !== null ? activeInlineMenus.get(chatId) ?? null : null;
  const callbackMessageId = getCallbackMessageId(ctx);
  const callbackData = ctx.callbackQuery?.data ?? "";
  const isActive = !!activeMetadata && callbackMessageId !== null && activeMetadata.menuKind === menuKind && activeMetadata.messageId === callbackMessageId;
  if (isActive) return true;

  if (chatId !== null && callbackMessageId !== null && (callbackData.startsWith(`${menuKind}:`) || callbackData.startsWith(`${INLINE_MENU_CANCEL_PREFIX}${menuKind}`))) {
    activeInlineMenus.set(chatId, { menuKind, messageId: callbackMessageId });
    logger.debug(`[InlineMenu] Rehydrated menu from callback: kind=${menuKind}, messageId=${callbackMessageId}, chatId=${chatId}`);
    return true;
  }

  logger.debug(`[InlineMenu] Stale callback ignored: expectedKind=${menuKind}, callbackMessageId=${callbackMessageId || "none"}, chatId=${chatId ?? "none"}`);
  await ctx.answerCallbackQuery({ text: t("inline.inactive_callback"), show_alert: true }).catch(() => {});
  return false;
}

export function getActiveInlineMenu(chatId?: number): ActiveInlineMenuMetadata | null {
  if (typeof chatId === "number") return activeInlineMenus.get(chatId) ?? null;
  return getActiveInlineMenuMetadata(interactionManager.getSnapshot());
}

export async function closeActiveInlineMenu(ctx: Context, reason = "navigation"): Promise<void> {
  const chatId = getChatId(ctx);
  const active = chatId !== null ? activeInlineMenus.get(chatId) ?? null : null;
  if (!active || !ctx.chat?.id) { clearActiveInlineMenu(reason, chatId ?? undefined); return; }
  await ctx.api.deleteMessage(ctx.chat.id, active.messageId).catch(() => {});
  clearActiveInlineMenu(reason, chatId ?? undefined);
}

export function clearActiveInlineMenu(reason: string, chatId?: number): void {
  if (typeof chatId === "number") activeInlineMenus.delete(chatId);
  else activeInlineMenus.clear();
  const state = interactionManager.getSnapshot();
  if (state?.kind !== "inline") return;
  const stateChatId = state.metadata.chatId;
  if (typeof chatId === "number" && typeof stateChatId === "number" && stateChatId !== chatId) return;
  interactionManager.clear(reason);
}
