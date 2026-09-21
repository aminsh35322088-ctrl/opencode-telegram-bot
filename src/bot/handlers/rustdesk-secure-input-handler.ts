import type { Context } from "grammy";
import {
  rustDeskSecureInputManager,
  type RustDeskSecureInputChallenge,
} from "../../app/managers/rustdesk-secure-input-manager.js";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import {
  createRustDeskBridgeClientFromEnv,
  RustDeskBridgeHttpError,
} from "../../app/services/rustdesk-bridge-service.js";
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

const TERMINAL_CREDENTIAL_ERROR_CODES = new Set([
  "credential_request_not_found",
  "credential_request_expired",
  "credential_request_superseded",
  "credential_request_invalid",
  "credential_not_ready",
]);

async function clearSecureInputChallenge(
  ctx: Context,
  sessionId: string,
  challenge: RustDeskSecureInputChallenge,
  reason: string,
): Promise<void> {
  rustDeskSecureInputManager.clear(sessionId, challenge.credentialRequestId);
  const interaction = interactionManager.getSnapshot();
  if (
    interaction?.kind === "custom" &&
    interaction.metadata.flow === "rustdesk-secure-input" &&
    interaction.metadata.sessionId === sessionId &&
    interaction.metadata.credentialRequestId === challenge.credentialRequestId
  ) {
    interactionManager.clear(reason);
  }
  if (challenge.promptMessageId) {
    await ctx.api.deleteMessage(challenge.chatId, challenge.promptMessageId).catch(() => {});
  }
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

    await clearSecureInputChallenge(
      ctx,
      sessionId,
      challenge,
      "rustdesk_secure_input_submitted",
    );
    await ctx.reply(t("rustdesk.secure_input.submitted"));
  } catch (error) {
    logger.error("[RustDesk] Secure credential submission failed:", error);
    if (
      error instanceof RustDeskBridgeHttpError &&
      error.errorCode &&
      TERMINAL_CREDENTIAL_ERROR_CODES.has(error.errorCode)
    ) {
      await clearSecureInputChallenge(
        ctx,
        sessionId,
        challenge,
        "rustdesk_secure_input_rejected_by_bridge",
      );
    }
    await ctx.reply(t("rustdesk.secure_input.failed"));
  }

  return true;
}
