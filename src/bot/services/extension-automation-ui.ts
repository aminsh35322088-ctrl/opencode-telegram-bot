import { InlineKeyboard, type Api, type Context } from "grammy";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import {
  approveExtensionEnsure,
  cancelExtensionEnsure,
  completeExtensionOAuth,
  findPendingExtensionEnsure,
  finalizeExtensionCredential,
  getExtensionEnsureRequest,
  getPendingExtensionOAuth,
} from "../../app/services/extension-ensure-service.js";
import {
  bindSecureCredentialChallenge,
  cancelSecureCredentialChallenge,
  findUnboundSecureCredentialChallenge,
  getSecureCredentialChallenge,
  submitSecureCredential,
} from "../../app/services/secure-credential-broker.js";
import { getStoredExtension } from "../../app/services/extension-store.js";
import { getTopicRuntimeContext } from "../../app/services/topic-runtime-context.js";
import { getCurrentSession } from "../../app/services/session-service.js";
import { opencodeClient } from "../../opencode/client.js";
import { logger } from "../../utils/logger.js";

const presented = new Set<string>();

function threadIdFromContext(ctx: Context): number | undefined {
  const value = (ctx.message ?? ctx.callbackQuery?.message) as { message_thread_id?: number } | undefined;
  return typeof value?.message_thread_id === "number" ? value.message_thread_id : undefined;
}

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

function credentialKeyboard(challengeId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔑 Enter key", `credauto:e:${challengeId}`)
    .text("❌ Cancel", `credauto:c:${challengeId}`);
}

async function resumeSession(sessionId: string, directory: string): Promise<void> {
  const { error } = await opencodeClient.session.promptAsync({
    sessionID: sessionId,
    directory,
    parts: [{
      type: "text",
      text: "Extension setup completed with explicit user approval. Continue the original request using the now-available capability. Do not repeat installation or ask for the credential value. If this Extension exposes useful runtime tools and it has no generated Action Pack yet, inspect those tools and register a small normalized namespaced pack with generated-actions.register; never re-enable an action the user disabled. For a newly added model provider, do one provider-level check of its public models/pricing/docs page and record only well-supported free-model policy evidence, rather than researching every model separately.",
    }],
  });
  if (error) logger.warn(`[Extensions] Could not resume session after setup: session=${sessionId}`);
}

export async function presentPendingExtensionAutomation(api: Api, chatId: number, sessionId: string): Promise<boolean> {
  const request = findPendingExtensionEnsure(sessionId);
  if (request && !presented.has(request.id)) {
    presented.add(request.id);
    const text = [
      `🧩 <b>${request.name}</b> required`,
      request.purpose,
      "",
      `${request.authType === "none" ? "No auth" : request.authType.toUpperCase()} · ${request.kind}`,
    ].join("\n");
    await api.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: approvalKeyboard(request.id) });
    return true;
  }
  const challenge = findUnboundSecureCredentialChallenge(sessionId);
  if (challenge && !presented.has(challenge.id)) {
    presented.add(challenge.id);
    const extension = await getStoredExtension(challenge.extensionId);
    await api.sendMessage(
      chatId,
      `🔐 <b>Credential required</b>\n${extension?.name ?? challenge.extensionId}\n\nThe secret is encrypted and is never exposed to the AI model.`,
      { parse_mode: "HTML", reply_markup: credentialKeyboard(challenge.id) },
    );
    return true;
  }
  return false;
}

async function editReady(ctx: Context, name: string): Promise<void> {
  await ctx.editMessageText(`✅ <b>${name}</b> ready`, { parse_mode: "HTML" }).catch(() => {});
}

export async function handleExtensionAutomationCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data || (!data.startsWith("extauto:") && !data.startsWith("credauto:"))) return false;
  const [, action, id] = data.split(":");
  if (!action || !id || !ctx.chat?.id) return true;
  const threadId = threadIdFromContext(ctx);

  if (data.startsWith("extauto:")) {
    const request = getExtensionEnsureRequest(id);
    if (!request) {
      await ctx.answerCallbackQuery({ text: "This request expired.", show_alert: true }).catch(() => {});
      return true;
    }
    if (currentSessionId() !== request.sessionId) {
      await ctx.answerCallbackQuery({ text: "This approval belongs to another Topic.", show_alert: true }).catch(() => {});
      return true;
    }
    if (action === "i") {
      const info = [request.name, `Type: ${request.kind}`, `Auth: ${request.authType}`, `Source: ${request.source}`, `Reason: ${request.purpose}`].join("\n");
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
    if (result.status === "ready") {
      await editReady(ctx, result.extension.name);
      await resumeSession(request.sessionId, request.projectDirectory);
      return true;
    }
    if (result.status === "awaiting-credential") {
      await ctx.editMessageText(
        `🔐 <b>Credential required</b>\n${result.extension.name}\n\nThe secret is encrypted and is never exposed to the AI model.`,
        { parse_mode: "HTML", reply_markup: credentialKeyboard(result.challengeId) },
      );
      return true;
    }
    await ctx.editMessageText(
      `🔐 <b>Sign in required</b>\n${result.extension.name}\n\nAfter sign-in, paste the callback URL here.`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().url("🔐 Sign in", result.authorizationUrl) },
    );
    return true;
  }

  const challenge = getSecureCredentialChallenge(id);
  if (!challenge) {
    await ctx.answerCallbackQuery({ text: "This credential request expired.", show_alert: true }).catch(() => {});
    return true;
  }
  if (currentSessionId() !== challenge.sessionId) {
    await ctx.answerCallbackQuery({ text: "This credential request belongs to another Topic.", show_alert: true }).catch(() => {});
    return true;
  }
  if (action === "c") {
    cancelSecureCredentialChallenge(id);
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.editMessageText("❌ Credential entry cancelled").catch(() => {});
    return true;
  }
  if (action !== "e") return true;
  if (!ctx.from?.id) throw new Error("Secure credential input requires an authenticated Telegram user.");
  bindSecureCredentialChallenge(id, ctx.chat.id, threadId, ctx.from.id);
  const message = ctx.callbackQuery?.message;
  const messageId = message && "message_id" in message ? message.message_id : undefined;
  interactionManager.start({
    kind: "custom",
    expectedInput: "text",
    metadata: {
      flow: "secure-extension-credential",
      challengeId: id,
      extensionId: challenge.extensionId,
      messageId,
    },
  });
  await ctx.answerCallbackQuery().catch(() => {});
  await ctx.editMessageText(
    "🔑 <b>Send the credential now</b>\n\nIt will be deleted from Telegram immediately, encrypted at rest, and never forwarded to the AI model.",
    { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("❌ Cancel", `credauto:c:${id}`) },
  );
  return true;
}

function secureInteraction(): { challengeId: string; extensionId: string; messageId?: number } | null {
  const state = interactionManager.getSnapshot();
  if (state?.kind !== "custom" || state.metadata.flow !== "secure-extension-credential") return null;
  const { challengeId, extensionId, messageId } = state.metadata;
  if (typeof challengeId !== "string" || typeof extensionId !== "string") return null;
  return { challengeId, extensionId, ...(typeof messageId === "number" ? { messageId } : {}) };
}
export function isSecureExtensionInputActive(): boolean {
  return Boolean(secureInteraction());
}

export async function handleSecureExtensionMessage(ctx: Context): Promise<boolean> {
  const text = ctx.message?.text;
  if (!text || !ctx.chat?.id) return false;
  const secure = secureInteraction();
  const topic = getTopicRuntimeContext();
  const session = topic?.sessionId ?? getCurrentSession()?.id;
  const threadId = threadIdFromContext(ctx);

  if (secure) {
    const challenge = getSecureCredentialChallenge(secure.challengeId);
    if (!challenge) {
      interactionManager.clear("secure_credential_expired");
      return false;
    }
    await ctx.deleteMessage().catch(() => {});
    try {
      if (!ctx.from?.id) throw new Error("Secure credential input requires an authenticated Telegram user.");
      const completed = await submitSecureCredential(secure.challengeId, ctx.chat.id, threadId, ctx.from.id, text);
      const extension = await finalizeExtensionCredential(completed.extensionId);
      interactionManager.clear("secure_credential_completed");
      if (secure.messageId) {
        await ctx.api.editMessageText(ctx.chat.id, secure.messageId, `✅ <b>${extension.name}</b> ready`, { parse_mode: "HTML" }).catch(() => {});
      }
      await resumeSession(completed.sessionId, completed.projectDirectory);
    } catch (error) {
      interactionManager.clear("secure_credential_failed");
      logger.warn("[Extensions] Secure credential validation failed", error instanceof Error ? error.name : "UnknownError");
      if (secure.messageId) await ctx.api.editMessageText(ctx.chat.id, secure.messageId, "❌ Credential rejected. Ask the model to retry authentication.").catch(() => {});
    }
    return true;
  }
  if (session) {
    const oauth = getPendingExtensionOAuth(session);
    if (oauth) {
      await ctx.deleteMessage().catch(() => {});
      try {
        const extension = await completeExtensionOAuth(session, text);
        await ctx.reply(`✅ ${extension.name} connected`);
        await resumeSession(oauth.sessionId, oauth.projectDirectory);
      } catch (error) {
        logger.warn("[Extensions] OAuth callback rejected", error instanceof Error ? error.name : "UnknownError");
        await ctx.reply("❌ OAuth callback was not accepted. Try signing in again.");
      }
      return true;
    }
  }
  return false;
}
