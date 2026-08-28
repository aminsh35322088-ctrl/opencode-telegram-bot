import type { Bot, Context } from "grammy";
import { config } from "../../config.js";
import { opencodeClient } from "../../opencode/client.js";
import { setCurrentSession, getCurrentSessionDirectory } from "../../app/services/session-service.js";
import { attachToSession } from "../../app/services/attach-service.js";
import { resolveProjectAgent } from "../../app/services/agent-selection-service.js";
import { keyboardManager } from "../keyboards/keyboard-manager.js";
import { ensureActiveInlineMenu, appendInlineMenuCancelButton } from "../menus/inline-menu.js";
import { buildSessionDeleteConfirmationKeyboard, buildSessionPreviewKeyboard, buildSessionSelectionMenuView, loadSessionPage, loadSessionPreviewItems, formatSessionPreview, parseSessionContinueCallback, parseSessionDeleteCallback, parseSessionDeleteConfirmCallback, parseSessionPreviewCallback, SESSION_BACK_CALLBACK, SESSION_NO_CALLBACK } from "../menus/session-selection-menu.js";
import { clearAllInteractionState } from "../../app/managers/interaction-manager.js";
import { isForegroundBusy } from "../../app/services/run-control-service.js";
import { replyBusyBlocked } from "../messages/busy-blocked-renderer.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";

export interface SessionPreviewDeps { bot: Bot<Context>; ensureEventSubscription: (directory: string) => Promise<void>; }

export async function handleSessionPreviewCallback(ctx: Context, deps: SessionPreviewDeps): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data) return false;

  const previewId = parseSessionPreviewCallback(data);
  const continueId = parseSessionContinueCallback(data);
  const deleteId = parseSessionDeleteCallback(data);
  const deleteConfirmId = parseSessionDeleteConfirmCallback(data);
  const isBack = data === SESSION_BACK_CALLBACK;
  const isNo = data === SESSION_NO_CALLBACK;
  if (!previewId && !continueId && !deleteId && !deleteConfirmId && !isBack && !isNo) return false;

  if (isForegroundBusy()) { await replyBusyBlocked(ctx); return true; }
  if (!(await ensureActiveInlineMenu(ctx, "session"))) return true;

  const directory = getCurrentSessionDirectory();

  try {
    if (isBack || isNo) {
      const pageData = await loadSessionPage(directory, 0, config.bot.sessionsListLimit);
      const view = buildSessionSelectionMenuView(pageData, config.bot.sessionsListLimit);
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(view.text, { reply_markup: appendInlineMenuCancelButton(view.keyboard, "session") });
      return true;
    }

    const sessionId = previewId ?? continueId ?? deleteId ?? deleteConfirmId;
    if (!sessionId) return true;
    const { data: session, error } = await opencodeClient.session.get({ sessionID: sessionId, directory });
    if (error || !session) throw error || new Error("Session not found");

    if (deleteConfirmId) {
      const current = getCurrentSession();
      await opencodeClient.session.delete({ sessionID: session.id, directory });
      if (current?.id === session.id) {
        setCurrentSession(undefined as never);
        clearAllInteractionState("session_deleted");
      }
      const pageData = await loadSessionPage(directory, 0, config.bot.sessionsListLimit);
      const view = buildSessionSelectionMenuView(pageData, config.bot.sessionsListLimit);
      await ctx.answerCallbackQuery({ text: "Chat deleted" });
      await ctx.editMessageText(view.text, { reply_markup: appendInlineMenuCancelButton(view.keyboard, "session") });
      return true;
    }

    if (deleteId) {
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(`🗑 Delete chat?\n\n💬 ${session.title}\n\nThis permanently removes this chat from OpenCode history.`, { reply_markup: buildSessionDeleteConfirmationKeyboard(session.id) });
      return true;
    }

    if (previewId) {
      const items = await loadSessionPreviewItems(session.id, directory, 10);
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(formatSessionPreview(session.title, items), { reply_markup: buildSessionPreviewKeyboard(session.id) });
      return true;
    }

    const sessionInfo = { id: session.id, title: session.title, directory };
    setCurrentSession(sessionInfo);
    clearAllInteractionState("session_preview_continue");
    await attachToSession({ bot: deps.bot, chatId: ctx.chat!.id, session: sessionInfo, ensureEventSubscription: deps.ensureEventSubscription });
    keyboardManager.updateAgent(await resolveProjectAgent());
    await ctx.answerCallbackQuery({ text: "Chat resumed" });
    await ctx.editMessageText(`✅ Chat resumed\n\n💬 ${session.title}`);
    return true;
  } catch (error) {
    logger.error("[Sessions] Error handling session history:", error);
    await ctx.answerCallbackQuery({ text: t("sessions.select_error"), show_alert: true }).catch(() => {});
    return true;
  }
}
