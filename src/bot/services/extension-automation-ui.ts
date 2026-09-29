import { InlineKeyboard, type Api, type Context } from "grammy";
import {
  approveExtensionEnsure,
  cancelExtensionEnsure,
  findPendingExtensionEnsure,
  getExtensionEnsureRequest,
} from "../../app/services/extension-ensure-service.js";
import { beginCoreRunForSession, captureCurrentCoreBindingOwner, dispatchCorePrompt, finishCoreRunForSession } from "../../core/native-core-service.js";
import { assistantRunState } from "../../app/managers/assistant-run-state-manager.js";
import { foregroundSessionState } from "../../app/managers/foreground-session-state-manager.js";
import { markAttachedSessionBusy, markAttachedSessionIdle } from "../../app/services/attach-service.js";
import { summaryAggregator } from "../../app/managers/summary-aggregation-manager.js";

const presented = new Set<string>();

function approvalKeyboard(requestId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Allow", `extauto:a:${requestId}`)
    .text("❌ Cancel", `extauto:c:${requestId}`)
    .row()
    .text("ℹ️ Info", `extauto:i:${requestId}`);
}

async function resumeSession(sessionId: string, directory: string, run: Awaited<ReturnType<typeof beginCoreRunForSession>>): Promise<void> {
  try {
    foregroundSessionState.markBusy(sessionId, directory);
    await markAttachedSessionBusy(sessionId);
    assistantRunState.startRun(sessionId, { startedAt: Date.now() }, run.runId);
    summaryAggregator.beginRun(sessionId);
    const result = await dispatchCorePrompt(run, {
      sessionID: sessionId,
      directory,
      parts: [{
        type: "text",
        text: "Plugin setup completed. Continue the original request using the installed plugin. Do not repeat installation.",
      }],
    });
    if ("error" in result && result.error) throw result.error;
  } catch (error) {
    assistantRunState.clearRun(sessionId, "extension_resume_error");
    finishCoreRunForSession(sessionId);
    foregroundSessionState.markIdle(sessionId);
    await markAttachedSessionIdle(sessionId);
    throw error;
  }
}

export async function presentPendingExtensionAutomation(
  api: Api,
  chatId: number,
  sessionId: string,
): Promise<boolean> {
  const request = findPendingExtensionEnsure(sessionId);
  if (!request || presented.has(request.id)) return false;
  presented.add(request.id);
  const text = [
    `🧩 <b>${request.name}</b> plugin requested`,
    request.purpose,
    "",
    `Source · ${request.source}`,
  ].join("\n");
  await api.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: approvalKeyboard(request.id),
  });
  return true;
}

async function editReady(ctx: Context, name: string): Promise<void> {
  await ctx.editMessageText(`✅ <b>${name}</b> ready`, { parse_mode: "HTML" }).catch(() => {});
}

export async function handleExtensionAutomationCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith("extauto:")) return false;
  const [, action, id] = data.split(":");
  if (!action || !id || !ctx.chat?.id) return true;

  const request = getExtensionEnsureRequest(id);
  if (!request) {
    await ctx.answerCallbackQuery({ text: "This plugin request expired.", show_alert: true }).catch(() => {});
    return true;
  }
  let owner;
  try { owner = captureCurrentCoreBindingOwner(); } catch { /* No bound AI Topic. */ }
  if (owner?.sessionId !== request.sessionId || owner.directory !== request.projectDirectory) {
    await ctx.answerCallbackQuery({ text: "This approval belongs to another Topic.", show_alert: true }).catch(() => {});
    return true;
  }
  if (action === "i") {
    const info = [
      request.name,
      "Type: plugin",
      `Source: ${request.source}`,
      `Reason: ${request.purpose}`,
    ].join("\n");
    await ctx.answerCallbackQuery({ text: info.slice(0, 190), show_alert: true }).catch(() => {});
    return true;
  }

  if (action === "c") {
    cancelExtensionEnsure(id);
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.editMessageText(`❌ ${request.name} setup cancelled`).catch(() => {});
    return true;
  }
  if (action !== "a") return true;

  await ctx.answerCallbackQuery().catch(() => {});
  const run = await beginCoreRunForSession(request.sessionId, request.projectDirectory, "extension_resume");
  try {
    const result = await approveExtensionEnsure(id);
    await editReady(ctx, result.extension.name);
    await resumeSession(request.sessionId, request.projectDirectory, run);
  } catch (error) {
    finishCoreRunForSession(request.sessionId);
    throw error;
  }
  return true;
}
