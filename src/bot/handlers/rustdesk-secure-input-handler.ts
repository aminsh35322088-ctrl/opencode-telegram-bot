[Reading 73 lines from start (total: 73 lines, 0 remaining)]

import type { Context } from "grammy";
import { rustDeskSecureInputManager } from "../../app/managers/rustdesk-secure-input-manager.js";
import { createRustDeskBridgeClientFromEnv } from "../../app/services/rustdesk-bridge-service.js";
import { getCurrentSession } from "../../app/services/session-service.js";
import { getTopicRuntimeContext } from "../../app/services/topic-runtime-context.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";

const PASSTHROUGH_COMMANDS = new Set([
  "/abort",
  "/stop",
  "/detach",
  "/status",
  "/help",
  "/opencode_stop",
  "/pause",
  "/resume",
  "/delete_topic",
  "/start",
  "/settings",
]);

function normalizedCommand(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const command = trimmed.split(/\s+/)[0]?.split("@")[0]?.toLowerCase();
  return command && command.length > 1 ? command : null;
}

function currentSessionId(): string | null {
  return getTopicRuntimeContext()?.sessionId ?? getCurrentSession()?.id ?? null;
}

export async function handleRustDeskSecureInputMessage(ctx: Context): Promise<boolean> {
  const sessionId = currentSessionId();
  if (!sessionId || !ctx.chat?.id || typeof ctx.message?.text !== "string") return false;

  const challenge = rustDeskSecureInputManager.get(sessionId);
  if (!challenge || challenge.chatId !== ctx.chat.id) return false;

  const command = normalizedCommand(ctx.message.text);
  if (command && PASSTHROUGH_COMMANDS.has(command)) return false;

  const value = ctx.message.text;
  if (!value) return true;

  const messageId = ctx.message.message_id;
  if (messageId) {
    await ctx.api.deleteMessage(ctx.chat.id, messageId).catch((error) => {
      logger.warn("[RustDesk] Could not delete secure-input Telegram message:", error);
    });
  }

  try {
    const client = createRustDeskBridgeClientFromEnv();
    await client.submitCredential({
      credentialRequestId: challenge.credentialRequestId,
      credential: value,
      trustThisDevice: false,
    });

    rustDeskSecureInputManager.clear(sessionId, challenge.credentialRequestId);
    if (challenge.promptMessageId) {
      await ctx.api.deleteMessage(challenge.chatId, challenge.promptMessageId).catch(() => {});
    }
    await ctx.reply(t("rustdesk.secure_input.submitted"));
  } catch (error) {
    logger.error("[RustDesk] Secure credential submission failed:", error);
    await ctx.reply(t("rustdesk.secure_input.failed"));
  }

  return true;
}

[executed on device: runnervmlun5p (3784ff4d-04bd-49e4-95bf-176085794429)]