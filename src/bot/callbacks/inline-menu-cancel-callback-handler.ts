import type { Context } from "grammy";
import {
  clearActiveInlineMenu,
  ensureActiveInlineMenu,
  INLINE_MENU_CANCEL_PREFIX,
  isInlineMenuKind,
  LEGACY_CONTEXT_CANCEL_CALLBACK,
  type InlineMenuKind,
} from "../menus/inline-menu.js";
import { logger } from "../../utils/logger.js";
import { cancelMenu } from "./feedback.js";

export async function handleInlineMenuCancel(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data) {
    return false;
  }

  let menuKind: InlineMenuKind | null = null;

  if (data === LEGACY_CONTEXT_CANCEL_CALLBACK) {
    menuKind = "context";
  } else if (data.startsWith(INLINE_MENU_CANCEL_PREFIX)) {
    const rawKind = data.slice(INLINE_MENU_CANCEL_PREFIX.length);
    if (!isInlineMenuKind(rawKind)) {
      return false;
    }

    menuKind = rawKind;
  } else {
    return false;
  }

  try {
    const isActive = await ensureActiveInlineMenu(ctx, menuKind);
    if (!isActive) {
      await ctx.answerCallbackQuery({ text: "Already closed" }).catch(() => {});
      return true;
    }

    clearActiveInlineMenu(`inline_menu_cancel:${menuKind}`);
    await cancelMenu(ctx);
    await ctx.answerCallbackQuery({ text: "Cancelled" }).catch(() => {});

    logger.debug(`[InlineMenu] Menu cancelled: kind=${menuKind}`);
    return true;
  } catch (error) {
    logger.error(`[InlineMenu] Failed to cancel menu: kind=${menuKind}`, error);
    await ctx.answerCallbackQuery({ text: "Cancel failed" }).catch(() => {});
    return true;
  }
}
