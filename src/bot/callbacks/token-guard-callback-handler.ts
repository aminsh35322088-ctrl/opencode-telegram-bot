import type { Context } from "grammy";
import { ensureActiveInlineMenu, appendInlineMenuCancelButton } from "../menus/inline-menu.js";
import { buildSettingsMenuView } from "../menus/settings-menu.js";
import { buildTokenGuardMenuView, TOKEN_GUARD_BACK_CALLBACK } from "../menus/token-guard-menu.js";
import { t } from "../../i18n/index.js";

export async function handleTokenGuardCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("tokenguard:")) return false;

  if (data === TOKEN_GUARD_BACK_CALLBACK) {
    if (!(await ensureActiveInlineMenu(ctx, "settings"))) return true;
    const { text, keyboard } = buildSettingsMenuView();
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(text, { reply_markup: appendInlineMenuCancelButton(keyboard, "settings") });
    return true;
  }

  if (data === "tokenguard:auto" || data === "tokenguard:menu") {
    if (data === "tokenguard:auto" && !(await ensureActiveInlineMenu(ctx, "settings"))) return true;
    const { text, keyboard } = await buildTokenGuardMenuView();
    await ctx.answerCallbackQuery({ text: "Token Guard: Auto" });
    await ctx.editMessageText(text, { reply_markup: appendInlineMenuCancelButton(keyboard, "settings") });
    return true;
  }

  await ctx.answerCallbackQuery({ text: t("callback.unknown_command") });
  return true;
}
