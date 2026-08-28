import type { Context } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { getCurrentSession } from "../../app/services/session-service.js";
import { abortCurrentOperation } from "./abort-command.js";
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

const RESUME_PROMPT =
  "[resume] Continue the interrupted task from the current session state. Preserve completed work, inspect the current state, and continue only what remains. Do not restart completed work.";

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
    if (error) throw error;
    const state = (data as Record<string, { type?: string }> | undefined)?.[session.id];

    if (state?.type !== "busy") {
      await ctx.reply("ℹ️ Nothing is running right now, so there is nothing to pause.");
      return;
    }

    await abortCurrentOperation(ctx, { notifyUser: false });

    const { data: after, error: afterError } = await opencodeClient.session.status({
      directory: session.directory,
    });
    const finalState = (after as Record<string, { type?: string }> | undefined)?.[session.id];

    if (afterError || finalState?.type === "busy") {
      await ctx.reply("⚠️ I could not confirm a safe pause. The session was left in its current state.");
      return;
    }

    setPausedSession(session);
    keyboardManager.setPaused(true);

    const model = getStoredModel();
    const displayModel = formatModelForDisplay(model.providerID, model.modelID);
    const keyboard = keyboardManager.getKeyboard();
    await ctx.reply(
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
      { parse_mode: "HTML", ...(keyboard ? { reply_markup: keyboard } : {}) },
    );
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
