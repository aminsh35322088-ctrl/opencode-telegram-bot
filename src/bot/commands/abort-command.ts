import type { Context } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { getCurrentSession } from "../../app/services/session-service.js";
import { clearAllInteractionState } from "../../app/managers/interaction-manager.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { foregroundSessionState } from "../../app/managers/foreground-session-state-manager.js";
import { assistantRunState } from "../../app/managers/assistant-run-state-manager.js";
import { markAttachedSessionIdle } from "../../app/services/attach-service.js";
import { markUserAbortRequested } from "../../app/managers/abort-suppression-manager.js";
import { promptQueue } from "../../app/managers/prompt-queue-manager.js";
import { promptAttachment } from "../../app/managers/prompt-attachment-manager.js";
import { keyboardManager } from "../keyboards/keyboard-manager.js";
import { stopSessionStallWatchdog } from "../../app/services/session-stall-watchdog.js";

type SessionState = "idle" | "busy" | "retry" | "not-found";
export type AbortResult = "confirmed" | "unconfirmed" | "maybe-finished" | "timeout" | "error" | "no-session";

interface AbortCurrentOperationOptions { notifyUser?: boolean; }
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function abortLocalStreaming(): void { clearAllInteractionState("abort_command"); }

async function releaseAbortBusyState(sessionId: string, reason: string): Promise<void> {
  stopSessionStallWatchdog(sessionId);
  foregroundSessionState.markIdle(sessionId);
  assistantRunState.clearRun(sessionId, reason);
  await markAttachedSessionIdle(sessionId);
}

async function restoreMainKeyboard(ctx: Context): Promise<void> {
  keyboardManager.setPaused(false);
  const keyboard = keyboardManager.getKeyboard();
  if (!keyboard || !ctx.chat?.id) return;
  await ctx.reply("⌨️ Controls restored.", { reply_markup: keyboard });
}

async function pollSessionStatus(sessionId: string, directory: string, maxWaitMs = 5000): Promise<SessionState> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    try {
      const { data, error } = await opencodeClient.session.status({ directory });
      if (error || !data) break;
      const sessionStatus = (data as Record<string, { type?: string }>)[sessionId];
      if (!sessionStatus) return "not-found";
      if (sessionStatus.type === "idle" || sessionStatus.type === "error") return "idle";
      if (sessionStatus.type !== "busy" && sessionStatus.type !== "retry") return "not-found";
      await sleep(250);
    } catch (error) {
      logger.warn("[Abort] Failed to poll session status:", error);
      break;
    }
  }
  return "busy";
}

export async function abortCurrentOperation(ctx: Context, options: AbortCurrentOperationOptions = {}): Promise<AbortResult> {
  const notifyUser = options.notifyUser ?? true;
  try {
    abortLocalStreaming();
    promptQueue.clear("abort_command");
    promptAttachment.clear("abort_command");
    const currentSession = getCurrentSession();
    if (!currentSession) {
      if (notifyUser) await ctx.reply(t("stop.no_active_session"));
      return "no-session";
    }

    let waitingMessageId: number | null = null;
    let chatId: number | null = null;
    if (notifyUser) {
      const waitingMessage = await ctx.reply(t("stop.in_progress"));
      waitingMessageId = waitingMessage.message_id;
      chatId = ctx.chat?.id ?? null;
      if (!chatId) {
        logger.warn("[Abort] Chat context is missing while aborting active session");
        return "error";
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    markUserAbortRequested(currentSession.id);

    try {
      logger.info(`[Abort] Requesting session abort: session=${currentSession.id}`);
      const { data: abortResult, error: abortError } = await opencodeClient.session.abort(
        { sessionID: currentSession.id, directory: currentSession.directory },
        { signal: controller.signal },
      );
      clearTimeout(timeoutId);
      logger.info(`[Abort] Abort API result: session=${currentSession.id}, result=${String(abortResult)}, error=${abortError ? "yes" : "no"}`);

      if (abortError) {
        logger.warn("[Abort] Abort request failed; preserving local busy state because remote abort is unconfirmed:", abortError);
        if (notifyUser && chatId !== null && waitingMessageId !== null) await ctx.api.editMessageText(chatId, waitingMessageId, t("stop.warn_unconfirmed"));
        return "unconfirmed";
      }

      if (abortResult !== true) {
        const finalStatus = await pollSessionStatus(currentSession.id, currentSession.directory, 1500);
        if (finalStatus !== "busy" && finalStatus !== "retry") {
          await releaseAbortBusyState(currentSession.id, "abort_maybe_finished");
        }
        if (notifyUser && chatId !== null && waitingMessageId !== null) await ctx.api.editMessageText(chatId, waitingMessageId, t("stop.warn_maybe_finished"));
        return finalStatus === "busy" || finalStatus === "retry" ? "unconfirmed" : "maybe-finished";
      }

      const finalStatus = await pollSessionStatus(currentSession.id, currentSession.directory, 5000);
      logger.info(`[Abort] Final session status after abort: session=${currentSession.id}, status=${finalStatus}`);
      if (finalStatus === "idle" || finalStatus === "not-found") {
        await releaseAbortBusyState(currentSession.id, "abort_confirmed");
        if (notifyUser && chatId !== null && waitingMessageId !== null) await ctx.api.editMessageText(chatId, waitingMessageId, t("stop.success"));
        await restoreMainKeyboard(ctx);
        return "confirmed";
      }

      if (notifyUser && chatId !== null && waitingMessageId !== null) await ctx.api.editMessageText(chatId, waitingMessageId, t("stop.warn_still_busy"));
      return "unconfirmed";
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        logger.warn(`[Abort] Abort API request timed out: session=${currentSession.id}; preserving local busy state`);
        if (notifyUser && chatId !== null && waitingMessageId !== null) await ctx.api.editMessageText(chatId, waitingMessageId, t("stop.warn_timeout"));
        return "timeout";
      }
      logger.error("[Abort] Error while aborting session; preserving local busy state:", error);
      if (notifyUser && chatId !== null && waitingMessageId !== null) await ctx.api.editMessageText(chatId, waitingMessageId, t("stop.warn_local_only"));
      return "error";
    }
  } catch (error) {
    logger.error("[Abort] Unexpected error:", error);
    if (options.notifyUser ?? true) await ctx.reply(t("stop.error"));
    return "error";
  }
}

export async function abortCommand(ctx: Context): Promise<void> { await abortCurrentOperation(ctx); }
