import type { Bot, Context } from "grammy";
import { config } from "../../config.js";
import { opencodeClient } from "../../opencode/client.js";
import { getCurrentProject } from "../../app/stores/settings-store.js";
import { setCurrentSession } from "../../app/services/session-service.js";
import { attachToSession } from "../../app/services/attach-service.js";
import { resolveProjectAgent } from "../../app/services/agent-selection-service.js";
import { keyboardManager } from "../keyboards/keyboard-manager.js";
import { ensureActiveInlineMenu, appendInlineMenuCancelButton } from "../menus/inline-menu.js";
import {
  buildSessionPreviewKeyboard,
  buildSessionSelectionMenuView,
  loadSessionPage,
  loadSessionPreviewItems,
  formatSessionPreview,
  parseSessionContinueCallback,
  parseSessionPreviewCallback,
  SESSION_BACK_CALLBACK,
} from "../menus/session-selection-menu.js";
import { clearAllInteractionState } from "../../app/managers/interaction-manager.js";
import { isForegroundBusy } from "../../app/services/run-control-service.js";
import { replyBusyBlocked } from "../messages/busy-blocked-renderer.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";

export interface SessionPreviewDeps {
  bot: Bot<Context>;
  ensureEventSubscription: (directory: string) => Promise<void>;
}

export async function handleSessionPreviewCallback(ctx: Context, deps: SessionPreviewDeps): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data) return false;

  const previewId = parseSessionPreviewCallback(data);
  const continueId = parseSessionContinueCallback(data);
  const isBack = data === SESSION_BACK_CALLBACK;
  if (!previewId && !continueId && !isBack) return false;

  if (isForegroundBusy()) {
    await replyBusyBlocked(ctx);
    return true;
  }

  if (!(await ensureActiveInlineMenu(ctx, "session"))) return true;

  const project = getCurrentProject();
  if (!project) {
    await ctx.answerCallbackQuery({ text: t("sessions.select_project_first"), show_alert: true }).catch(() => {});
    return true;
  }

  try {
    if (isBack) {
      const pageData = await loadSessionPage(project.worktree, 0, config.bot.sessionsListLimit);
      const view = buildSessionSelectionMenuView(pageData, config.bot.sessionsListLimit);
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(view.text, { reply_markup: appendInlineMenuCancelButton(view.keyboard, "session") });
      return true;
    }

    const sessionId = previewId ?? continueId;
    if (!sessionId) return true;

    const { data: session, error } = await opencodeClient.session.get({
      sessionID: sessionId,
      directory: project.worktree,
    });
    if (error || !session) throw error || new Error("Session not found");

    if (previewId) {
      const items = await loadSessionPreviewItems(session.id, project.worktree, 10);
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(formatSessionPreview(session.title, items), {
        reply_markup: buildSessionPreviewKeyboard(session.id),
      });
      return true;
    }

    const sessionInfo = { id: session.id, title: session.title, directory: project.worktree };
    setCurrentSession(sessionInfo);
    clearAllInteractionState("session_preview_continue");
    await attachToSession({
      bot: deps.bot,
      chatId: ctx.chat!.id,
      session: sessionInfo,
      ensureEventSubscription: deps.ensureEventSubscription,
    });
    keyboardManager.updateAgent(await resolveProjectAgent());
    await ctx.answerCallbackQuery({ text: "Chat resumed" });
    await ctx.editMessageText(`✅ Chat resumed\n\n💬 ${session.title}`);
    return true;
  } catch (error) {
    logger.error("[Sessions] Error handling compact session history:", error);
    await ctx.answerCallbackQuery({ text: t("sessions.select_error"), show_alert: true }).catch(() => {});
    return true;
  }
}
