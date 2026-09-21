import type { Context } from "grammy";
import { permissionManager } from "../../app/managers/permission-manager.js";
import type { PermissionReply } from "../../app/types/permission.js";
import { opencodeClient } from "../../opencode/client.js";
import { getCurrentProject } from "../../app/stores/settings-store.js";
import { getCurrentSession } from "../../app/services/session-service.js";
import { summaryAggregator } from "../../app/managers/summary-aggregation-manager.js";
import {
  createRustDeskBridgeClientFromEnv,
  type RustDeskAction,
} from "../../app/services/rustdesk-bridge-service.js";
import { clearPermissionInteraction, syncPermissionInteractionState } from "../menus/permission-menu.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";

function getCallbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  if (!message || !("message_id" in message)) {
    return null;
  }

  const messageId = (message as { message_id?: number }).message_id;
  return typeof messageId === "number" ? messageId : null;
}

interface RustDeskPermissionMetadata {
  action: RustDeskAction;
  permissionGrantId: string;
  connectionId?: string;
}

function parseRustDeskPermissionMetadata(
  request: ReturnType<typeof permissionManager.getRequest>,
): RustDeskPermissionMetadata | null {
  if (!request || request.metadata.source !== "rustdesk") return null;
  const action = request.metadata.action;
  const permissionGrantId = request.metadata.permissionGrantId;
  const connectionId = request.metadata.connectionId;
  if (typeof action !== "string" || typeof permissionGrantId !== "string") return null;
  if (!/^perm_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(permissionGrantId)) {
    return null;
  }
  return {
    action: action as RustDeskAction,
    permissionGrantId,
    connectionId: typeof connectionId === "string" && connectionId.trim() ? connectionId : undefined,
  };
}

function isPermissionReply(value: string): value is PermissionReply {
  return value === "once" || value === "always" || value === "reject";
}

function isRustDeskPermissionGrantAlreadyActive(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as {
    errorCode?: unknown;
    payload?: { errorCode?: unknown } | null;
  };

  return (
    candidate.errorCode === "permission_grant_exists" ||
    candidate.payload?.errorCode === "permission_grant_exists"
  );
}

function isPermissionRequestNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as {
    _tag?: unknown;
    name?: unknown;
    message?: unknown;
    data?: { message?: unknown };
  };

  if (candidate._tag === "PermissionNotFoundError") {
    return true;
  }

  if (candidate.name === "NotFoundError") {
    return true;
  }

  return [candidate.message, candidate.data?.message].some(
    (message) =>
      typeof message === "string" && message.toLowerCase().includes("permission request not found"),
  );
}

export async function handlePermissionCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data) return false;

  if (!data.startsWith("permission:")) {
    return false;
  }

  logger.debug(`[PermissionHandler] Received callback: ${data}`);

  if (!permissionManager.isActive()) {
    clearPermissionInteraction("permission_inactive_callback");
    await ctx.answerCallbackQuery({ text: t("permission.inactive_callback"), show_alert: true });
    return true;
  }

  const callbackMessageId = getCallbackMessageId(ctx);
  if (!permissionManager.isActiveMessage(callbackMessageId)) {
    await ctx.answerCallbackQuery({ text: t("permission.inactive_callback"), show_alert: true });
    return true;
  }

  const requestIDs = permissionManager.getRequestIDs(callbackMessageId);
  if (requestIDs.length === 0) {
    await ctx.answerCallbackQuery({ text: t("permission.inactive_callback"), show_alert: true });
    return true;
  }

  const parts = data.split(":");
  const action = parts[1];

  if (!action || !isPermissionReply(action)) {
    await ctx.answerCallbackQuery({
      text: t("permission.processing_error_callback"),
      show_alert: true,
    });
    return true;
  }

  try {
    await handlePermissionReply(ctx, action, requestIDs, callbackMessageId);
  } catch (err) {
    logger.error("[PermissionHandler] Error handling callback:", err);
    await ctx.answerCallbackQuery({
      text: t("permission.processing_error_callback"),
      show_alert: true,
    });
  }

  return true;
}

async function handlePermissionReply(
  ctx: Context,
  reply: PermissionReply,
  requestIDs: string[],
  callbackMessageId: number | null,
): Promise<void> {
  const currentProject = getCurrentProject();
  const currentSession = getCurrentSession();
  const chatId = ctx.chat?.id;
  const directory = currentSession?.directory ?? currentProject?.worktree;
  const permissionType = permissionManager.getPermissionType(callbackMessageId);
  const visibleRequest = permissionManager.getRequest(callbackMessageId);
  const rustDeskPermission = parseRustDeskPermissionMetadata(visibleRequest);

  if (!directory || !chatId) {
    await ctx.answerCallbackQuery({
      text: t("permission.no_active_request_callback"),
      show_alert: true,
    });
    return;
  }

  const replyLabels: Record<PermissionReply, string> = {
    once: t("permission.reply.once"),
    always: t("permission.reply.always"),
    reject: t("permission.reply.reject"),
  };

  const effectiveReply: PermissionReply =
    rustDeskPermission && reply === "always" ? "once" : reply;

  logger.info(
    `[PermissionHandler] Sending permission reply: ${effectiveReply}, requestIDs=${requestIDs.join(",")}`,
  );

  if (rustDeskPermission && effectiveReply !== "reject") {
    try {
      const client = createRustDeskBridgeClientFromEnv();
      await client.grantPermission({
        action: rustDeskPermission.action,
        connectionId: rustDeskPermission.connectionId,
        scope: "once",
        permissionGrantId: rustDeskPermission.permissionGrantId,
      });
    } catch (error) {
      if (isRustDeskPermissionGrantAlreadyActive(error)) {
        logger.debug(
          `[PermissionHandler] RustDesk one-shot grant already active; retrying OpenCode release: grant=${rustDeskPermission.permissionGrantId}`,
        );
      } else {
        logger.error("[PermissionHandler] Failed to mint RustDesk permission grant:", error);
        await ctx.answerCallbackQuery({
          text: t("permission.processing_error_callback"),
          show_alert: true,
        });
        await ctx.api.sendMessage(chatId, t("permission.send_reply_error")).catch(() => {});
        return;
      }
    }
  }

  await ctx.answerCallbackQuery({ text: replyLabels[effectiveReply] });

  let firstError: unknown = null;

  for (const requestID of requestIDs) {
    const response = await opencodeClient.permission.reply({
      requestID,
      directory,
      reply: effectiveReply,
    });

    if (!response.error) {
      continue;
    }

    if (requestIDs.length > 1 && isPermissionRequestNotFound(response.error)) {
      logger.debug(
        `[PermissionHandler] Ignoring duplicate permission reply miss: requestID=${requestID}`,
      );
      continue;
    }

    firstError ??= response.error;
  }

  if (firstError) {
    logger.error("[PermissionHandler] Failed to send permission reply:", firstError);
    syncPermissionInteractionState({
      lastReplyError: true,
      requestIDs,
    });
    await ctx.api
      .sendMessage(chatId, t("permission.send_reply_error"))
      .catch(() => {});
    return;
  }

  if (effectiveReply === "always" && permissionType && !rustDeskPermission) {
    try {
      await permissionManager.rememberAlwaysAllowed(chatId, permissionType);
      logger.info(
        `[PermissionHandler] Persisted Always Allow for chat=${chatId} permission=${permissionType}`,
      );
    } catch (error) {
      logger.warn(
        `[PermissionHandler] Failed to persist Always Allow for chat=${chatId} permission=${permissionType}`,
        error,
      );
    }
  }

  permissionManager.removeByMessageId(callbackMessageId);

  if (callbackMessageId !== null) {
    await ctx.api.deleteMessage(chatId, callbackMessageId).catch((err) => {
      logger.warn(
        `[PermissionHandler] Failed to delete resolved permission message ${callbackMessageId}:`,
        err,
      );
    });
  }

  summaryAggregator.stopTypingIndicator();

  if (!permissionManager.isActive()) {
    clearPermissionInteraction("permission_replied");
    return;
  }

  syncPermissionInteractionState({
    lastRepliedRequestIDs: requestIDs,
  });
}
