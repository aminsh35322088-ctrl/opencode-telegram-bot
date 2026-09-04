import type { Context } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { getEffectiveCurrentSession } from "../../app/services/session-service.js";
import { abortCurrentOperation, type AbortResult } from "./abort-command.js";
import { keyboardManager } from "../keyboards/keyboard-manager.js";
import { clearPausedSession, getPausedSession, isChatPaused, setPausedSession } from "../../app/managers/paused-session-manager.js";
import { processUserPrompt, type ProcessPromptDeps } from "../handlers/prompt.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { formatModelForDisplay } from "../../app/types/model.js";
import { logger } from "../../utils/logger.js";
import { assistantRunState } from "../../app/managers/assistant-run-state-manager.js";
import { foregroundSessionState } from "../../app/managers/foreground-session-state-manager.js";

const RESUME_PROMPT = "[resume] Continue the interrupted task from the current session state. Preserve completed work, inspect the current state, and continue only what remains. Do not restart completed work.";
function isActiveStatus(type: string | undefined): boolean { return type === "busy" || type === "retry"; }
async function hasActiveRemoteTool(sessionId: string, directory: string): Promise<boolean> { try { const { data: messages, error } = await opencodeClient.session.messages({ sessionID: sessionId, directory, limit: 10 }); if (error || !messages) return false; return messages.some((message) => (message.parts as Array<{ type?: string; state?: { status?: string } }>).some((part) => part.type === "tool" && (part.state?.status === "running" || part.state?.status === "pending"))); } catch (error) { logger.debug("[Pause] Failed to inspect recent tool parts:", error); return false; } }
function describeAbortResult(result: AbortResult): string { switch (result) { case "confirmed": return "⏸️ Pause confirmed."; case "timeout": return "⚠️ OpenCode did not confirm the stop before the timeout. The chat was not marked paused."; case "unconfirmed": return "⚠️ OpenCode did not confirm a safe stop. The chat was not marked paused."; case "maybe-finished": return "ℹ️ The run appears to have finished before the stop completed."; case "no-session": return "ℹ️ There is no active chat to pause."; default: return "⚠️ Pause failed. The chat was not marked paused."; } }

export async function pauseCurrentChat(ctx: Context): Promise<void> {
  const session = await getEffectiveCurrentSession();
  if (!session) { await ctx.reply("ℹ️ There is no active chat to pause. Tap 💬 New Chat to start one."); return; }
  if (isChatPaused(session.id)) { await ctx.reply("⏸️ This chat is already paused."); return; }
  try {
    const { data, error } = await opencodeClient.session.status({ directory: session.directory });
    const state = (data as Record<string, { type?: string }> | undefined)?.[session.id];
    const localRunActive = assistantRunState.hasActiveRun(session.id);
    const foregroundActive = foregroundSessionState.getBusySessions().some((busySession) => busySession.sessionId === session.id);
    const remoteToolActive = await hasActiveRemoteTool(session.id, session.directory);
    logger.info(`[Pause] Button invoked: session=${session.id}, status=${state?.type ?? "missing"}, statusError=${error ? "yes" : "no"}, localRunActive=${localRunActive}, foregroundActive=${foregroundActive}, remoteToolActive=${remoteToolActive}`);
    if (error && !localRunActive && !foregroundActive && !remoteToolActive) throw error;
    if (!isActiveStatus(state?.type) && !localRunActive && !foregroundActive && !remoteToolActive) { await ctx.reply("ℹ️ Nothing is running right now, so there is nothing to pause."); return; }
    const progressMessage = await ctx.reply("⏳ Pausing the current run…");
    const abortResult = await abortCurrentOperation(ctx, { notifyUser: false });
    logger.info(`[Pause] Abort completed: session=${session.id}, result=${abortResult}`);
    if (abortResult !== "confirmed") { await ctx.api.editMessageText(ctx.chat!.id, progressMessage.message_id, describeAbortResult(abortResult)); return; }
    setPausedSession(session); keyboardManager.setPaused(true, session.id);
    const model = getStoredModel(); const displayModel = formatModelForDisplay(model.providerID, model.modelID);
    await ctx.api.editMessageText(ctx.chat!.id, progressMessage.message_id, ["⏸️ <b>Chat paused</b>", "", `💬 ${session.title}`, `🤖 ${displayModel}`, "", "The current run was interrupted safely. Your session, files, and history are still intact.", "", "Send a new prompt to continue from here, or tap <b>▶️ Resume</b> to continue without additional instructions."].join("\n"), { parse_mode: "HTML" });
    const keyboard = keyboardManager.getKeyboard(session.id); if (keyboard) await ctx.reply("▶️ Resume is ready. Sending a prompt will resume automatically.", { reply_markup: keyboard });
  } catch (error) { logger.error("[Pause] Failed to pause current chat:", error); await ctx.reply("⚠️ Pause failed. Nothing was changed beyond the attempted interruption."); }
}

export async function resumePausedChat(ctx: Context, deps: ProcessPromptDeps): Promise<void> {
  const currentSession = await getEffectiveCurrentSession();
  if (!currentSession) { await ctx.reply("ℹ️ There is no paused chat to resume."); return; }
  const session = getPausedSession(currentSession.id);
  if (!session) { await ctx.reply("ℹ️ This chat is not paused."); return; }
  const resumeModel = getStoredModel(); clearPausedSession(session.id); keyboardManager.setPaused(false, session.id);
  try {
    const dispatched = await processUserPrompt(ctx, RESUME_PROMPT, deps, [], resumeModel);
    if (!dispatched) { setPausedSession(session); keyboardManager.setPaused(true, session.id); await keyboardManager.sendKeyboardUpdate(ctx.chat?.id, true, session.id); return; }
    const displayModel = formatModelForDisplay(resumeModel.providerID, resumeModel.modelID); const keyboard = keyboardManager.getKeyboard(session.id);
    await ctx.reply(`▶️ Resuming <b>${session.title}</b> with <b>${displayModel}</b>.`, { parse_mode: "HTML", ...(keyboard ? { reply_markup: keyboard } : {}) });
  } catch (error) { setPausedSession(session); keyboardManager.setPaused(true, session.id); await keyboardManager.sendKeyboardUpdate(ctx.chat?.id, true, session.id); logger.error("[Resume] Failed to resume paused chat:", error); await ctx.reply("⚠️ Resume failed. The chat remains paused so you can change model/provider safely."); }
}

export async function resumePausedChatWithPrompt(ctx: Context, text: string, deps: ProcessPromptDeps): Promise<boolean> {
  const currentSession = await getEffectiveCurrentSession(); if (!currentSession || !isChatPaused(currentSession.id)) return false;
  const session = getPausedSession(currentSession.id); if (!session) return false; const prompt = text.trim(); if (!prompt) return false;
  const selectedModel = getStoredModel(); clearPausedSession(session.id); keyboardManager.setPaused(false, session.id);
  logger.info(`[Pause] Implicit resume from user prompt: session=${session.id}, promptLength=${prompt.length}`);
  try { const dispatched = await processUserPrompt(ctx, prompt, deps, [], selectedModel); if (!dispatched) { setPausedSession(session); keyboardManager.setPaused(true, session.id); await keyboardManager.sendKeyboardUpdate(ctx.chat?.id, true, session.id); return false; } await keyboardManager.sendKeyboardUpdate(ctx.chat?.id, true, session.id); return true; }
  catch (error) { setPausedSession(session); keyboardManager.setPaused(true, session.id); await keyboardManager.sendKeyboardUpdate(ctx.chat?.id, true, session.id); logger.error("[Pause] Failed implicit resume from user prompt:", error); await ctx.reply("⚠️ The prompt could not resume the paused chat. The chat remains paused."); return false; }
}
