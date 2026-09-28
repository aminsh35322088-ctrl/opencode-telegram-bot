import { InlineKeyboard, type Api, type Context } from "grammy";
import {
  approveExtensionEnsure,
  cancelExtensionEnsure,
  findPendingExtensionEnsure,
  getExtensionEnsureRequest,
} from "../../app/services/extension-ensure-service.js";
import { getTopicRuntimeContext } from "../../app/services/topic-runtime-context.js";
import { getCurrentSession } from "../../app/services/session-service.js";
import { opencodeClient } from "../../opencode/client.js";
import { logger } from "../../utils/logger.js";

const presented = new Set<string>();

function currentSessionId(): string | null {
  return getTopicRuntimeContext()?.sessionId ?? getCurrentSession()?.id ?? null;
}

function approvalKeyboard(requestId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Allow", `extauto:a:${requestId}`)
    .text("❌ Cancel", `extauto:c:${requestId}`)
    .row()
    .text("ℹ️ Info", `extauto:i:${requestId}`);
}

async function resumeSession(sessionId: string, directory: string): Promise<void> {
  const { error } = await opencodeClient.session.promptAsync({
    sessionID: sessionId,
    directory,
    parts: [{
      type: "text",
      text: "Plugin setup completed. Continue the original request using the installed plugin. Do not repeat installation.",
    }],
  });
  if (error) logger.warn(`[Extensions] Could not resume session after plugin setup: session=${sessionId}`);
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
  if (currentSessionId() !== request.sessionId) {
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
  const result = await approveExtensionEnsure(id);
  await editReady(ctx, result.extension.name);
  await resumeSession(request.sessionId, request.projectDirectory);
  return true;
}
