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

export function isInlineMenuKind(value: string): value is InlineMenuKind { return INLINE_MENU_KINDS.includes(value as InlineMenuKind); }
function getCallbackMessageId(ctx: Context): number | null { const message = ctx.callbackQuery?.message; if (!message || !("message_id" in message)) return null; const id = (message as { message_id?: number }).message_id; return typeof id === "number" ? id : null; }
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
      const message = await ctx.reply(options.text, replyOptions);
      messageId = message.message_id;
    }
  } else {
    const message = await ctx.reply(options.text, replyOptions);
    messageId = message.message_id;
  }

  interactionManager.start({ kind: "inline", expectedInput: "callback", metadata: { ...options.metadata, menuKind: options.menuKind, messageId } });
  logger.debug(`[InlineMenu] Opened/updated menu: kind=${options.menuKind}, messageId=${messageId}`);
  return messageId;
}

export async function ensureActiveInlineMenu(ctx: Context, menuKind: InlineMenuKind): Promise<boolean> {
  const activeMetadata = getActiveInlineMenuMetadata(interactionManager.getSnapshot());
  const callbackMessageId = getCallbackMessageId(ctx);
  const isActive = !!activeMetadata && callbackMessageId !== null && activeMetadata.menuKind === menuKind && activeMetadata.messageId === callbackMessageId;
  if (isActive) return true;
  logger.debug(`[InlineMenu] Stale callback ignored: expectedKind=${menuKind}, activeKind=${activeMetadata?.menuKind || "none"}, callbackMessageId=${callbackMessageId || "none"}, activeMessageId=${activeMetadata?.messageId || "none"}`);
  await ctx.answerCallbackQuery({ text: t("inline.inactive_callback"), show_alert: true }).catch(() => {});
  return false;
}

export function getActiveInlineMenu(): ActiveInlineMenuMetadata | null { return getActiveInlineMenuMetadata(interactionManager.getSnapshot()); }

export async function closeActiveInlineMenu(ctx: Context, reason = "navigation"): Promise<void> {
  const active = getActiveInlineMenu();
  if (!active || !ctx.chat?.id) { clearActiveInlineMenu(reason); return; }
  await ctx.api.deleteMessage(ctx.chat.id, active.messageId).catch(() => {});
  clearActiveInlineMenu(reason);
}

export function clearActiveInlineMenu(reason: string): void { const state = interactionManager.getSnapshot(); if (state?.kind === "inline") interactionManager.clear(reason); }
