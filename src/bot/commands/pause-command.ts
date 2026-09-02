import type { Context } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { getCurrentSession } from "../../app/services/session-service.js";
import { abortCurrentOperation, type AbortResult } from "./abort-command.js";
import { keyboardManager } from "../keyboards/keyboard-manager.js";
import {
  clearPausedSession,
  getPausedSession,
  isChatPaused,
  setPausedSession,
} from "../../app/managers/paused-session-manager.js";
import { processUserPrompt, type ProcessPromptDeps } from "../handlers/prompt.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { formatModelForDisplay } from "../../app/types/model.js";
import { logger } from "../../utils/logger.js";
import { assistantRunState } from "../../app/managers/assistant-run-state-manager.js";
import { foregroundSessionState } from "../../app/managers/foreground-session-state-manager.js";

const RESUME_PROMPT =
  "[resume] Continue the interrupted task from the current session state. Preserve completed work, inspect the current state, and continue only what remains. Do not restart completed work.";

function isActiveStatus(type: string | undefined): boolean {
  return type === "busy" || type === "retry";
}

function describeAbortResult(result: AbortResult): string {
  switch (result) {
    case "confirmed":
      return "⏸️ Pause confirmed.";
    case "timeout":
      return "⚠️ OpenCode did not confirm the stop before the timeout. The chat was not marked paused.";
    case "unconfirmed":
      return "⚠️ OpenCode did not confirm a safe stop. The chat was not marked paused.";
    case "maybe-finished":
      return "ℹ️ The run appears to have finished before the stop completed.";
    case "no-session":
      return "ℹ️ There is no active chat to pause.";
    default:
      return "⚠️ Pause failed. The chat was not marked paused.";
  }
}

export async function pauseCurrentChat(ctx: Context): Promise<void> {
  const session = getCurrentSession();
  if (!session) {
    await ctx.reply("ℹ️ There is no active chat to pause. Tap 💬 New Chat to start one.");
    return;
  }

  if (isChatPaused(session.id)) {
    await ctx.reply("⏸️ This chat is already paused.");
    return;
  }

  try {
    const { data, error } = await opencodeClient.session.status({ directory: session.directory });
    const state = (data as Record<string, { type?: string }> | undefined)?.[session.id];
    const localRunActive = assistantRunState.hasActiveRun(session.id);
    const foregroundActive = foregroundSessionState.getBusySessions().some(
      (busySession) => busySession.sessionId === session.id,
    );

    logger.info(
      `[Pause] Button invoked: session=${session.id}, status=${state?.type ?? "missing"}, statusError=${error ? "yes" : "no"}, localRunActive=${localRunActive}, foregroundActive=${foregroundActive}`,
    );

    if (error && !localRunActive && !foregroundActive) throw error;

    // OpenCode's session.status can lag real tool/session activity. The bot's
    // own run state is set before prompt execution and is therefore a second
    // independent signal. Abort when either source says work is active.
    if (!isActiveStatus(state?.type) && !localRunActive && !foregroundActive) {
      await ctx.reply("ℹ️ Nothing is running right now, so there is nothing to pause.");
      return;
    }

    const progressMessage = await ctx.reply("⏳ Pausing the current run…");
    const abortResult = await abortCurrentOperation(ctx, { notifyUser: false });
    logger.info(`[Pause] Abort completed: session=${session.id}, result=${abortResult}`);

    if (abortResult !== "confirmed") {
      await ctx.api.editMessageText(ctx.chat!.id, progressMessage.message_id, describeAbortResult(abortResult));
      return;
    }

    setPausedSession(session);
    keyboardManager.setPaused(true);

    const model = getStoredModel();
    const displayModel = formatModelForDisplay(model.providerID, model.modelID);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      progressMessage.message_id,
      [
        "⏸️ <b>Chat paused</b>",
        "",
        `💬 ${session.title}`,
        `🤖 ${displayModel}`,
        "",
        "The current run was interrupted safely. Your session, files, and history are still intact.",
        "",
        "Change the model/provider or recharge your API, then tap <b>▶️ Resume</b>.",
      ].join("\n"),
      { parse_mode: "HTML" },
    );

    const keyboard = keyboardManager.getKeyboard();
    if (keyboard) {
      await ctx.reply("▶️ Resume is ready.", { reply_markup: keyboard });
    }
  } catch (error) {
    logger.error("[Pause] Failed to pause current chat:", error);
    await ctx.reply("⚠️ Pause failed. Nothing was changed beyond the attempted interruption.");
  }
}

export async function resumePausedChat(ctx: Context, deps: ProcessPromptDeps): Promise<void> {
  const session = getPausedSession();
  if (!session) {
    await ctx.reply("ℹ️ There is no paused chat to resume.");
    return;
  }

  if (getCurrentSession()?.id !== session.id) {
    await ctx.reply("⚠️ The paused chat is not the active chat. Open it from 🕘 History first.");
    return;
  }

  clearPausedSession();
  keyboardManager.setPaused(false);

  try {
    const dispatched = await processUserPrompt(ctx, RESUME_PROMPT, deps);
    if (!dispatched) {
      setPausedSession(session);
      keyboardManager.setPaused(true);
      return;
    }

    const model = getStoredModel();
    const displayModel = formatModelForDisplay(model.providerID, model.modelID);
    const keyboard = keyboardManager.getKeyboard();
    await ctx.reply(
      `▶️ Resuming <b>${session.title}</b> with <b>${displayModel}</b>.`,
      { parse_mode: "HTML", ...(keyboard ? { reply_markup: keyboard } : {}) },
    );
  } catch (error) {
    setPausedSession(session);
    keyboardManager.setPaused(true);
    logger.error("[Resume] Failed to resume paused chat:", error);
    await ctx.reply("⚠️ Resume failed. The chat remains paused so you can change model/provider safely.");
  }
}
