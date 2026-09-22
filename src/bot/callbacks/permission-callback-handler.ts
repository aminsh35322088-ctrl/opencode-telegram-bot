import type { Context } from "grammy";
import { permissionManager } from "../../app/managers/permission-manager.js";
import type { PermissionReply, PermissionRequest } from "../../app/types/permission.js";
import {
  RUSTDESK_ACTIONS,
  discardRustDeskPermissionGrantHandoff,
  grantApprovedRustDeskPermission,
  type RustDeskAction,
} from "../../app/services/rustdesk-bridge-service.js";
import { opencodeClient } from "../../opencode/client.js";
import { getCurrentProject } from "../../app/stores/settings-store.js";
import { getCurrentSession } from "../../app/services/session-service.js";
import { summaryAggregator } from "../../app/managers/summary-aggregation-manager.js";
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

function isPermissionReply(value: string): value is PermissionReply {
  return value === "once" || value === "always" || value === "reject";
}

const RUSTDESK_ACTION_SET = new Set<string>(RUSTDESK_ACTIONS);

function isRustDeskPermissionRequest(request: PermissionRequest): boolean {
  return request.metadata.source === "rustdesk";
}

function getRustDeskApprovalHandoffRequest(request: PermissionRequest): {
  correlationId: string;
  action: RustDeskAction;
  sessionScope: string;
  connectionId?: string;
} {
  const correlationId = request.metadata.rustdeskApprovalCorrelationId;
  const action = request.metadata.action;
  const connectionId = request.metadata.connectionId;

  if (typeof correlationId !== "string" || !correlationId.trim()) {
    throw new Error("RustDesk permission request is missing approval correlation metadata");
  }
  if (typeof action !== "string" || !RUSTDESK_ACTION_SET.has(action)) {
    throw new Error("RustDesk permission request has an invalid action");
  }
  if (connectionId !== undefined && typeof connectionId !== "string") {
    throw new Error("RustDesk permission request has an invalid connection id");
  }

  return {
    correlationId,
    action: action as RustDeskAction,
    sessionScope: request.sessionID,
    connectionId,
  };
}

async function discardPreparedRustDeskHandoffs(
  prepared: Map<string, string>,
): Promise<void> {
  await Promise.all(
    [...prepared.values()].map((correlationId) =>
      discardRustDeskPermissionGrantHandoff(correlationId).catch(() => {}),
    ),
  );
}

async function prepareRustDeskPermissionHandoffs(
  requests: PermissionRequest[],
  reply: PermissionReply,
): Promise<Map<string, string>> {
  const rustDeskRequests = requests.filter(isRustDeskPermissionRequest);
  const prepared = new Map<string, string>();
  if (rustDeskRequests.length === 0 || reply === "reject") return prepared;
  if (reply !== "once") {
    throw new Error("RustDesk permissions only support one-shot approval");
  }

  try {
    for (const request of rustDeskRequests) {
      const handoffRequest = getRustDeskApprovalHandoffRequest(request);
      await grantApprovedRustDeskPermission(handoffRequest);
      prepared.set(request.id, handoffRequest.correlationId);
    }
    return prepared;
  } catch (error) {
    await discardPreparedRustDeskHandoffs(prepared);
    throw error;
  }
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
  const permissionRequests = permissionManager.getRequests(callbackMessageId);

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

  logger.info(
    `[PermissionHandler] Sending permission reply: ${reply}, requestIDs=${requestIDs.join(",")}`,
  );

  const preparedRustDeskHandoffs = await prepareRustDeskPermissionHandoffs(
    permissionRequests,
    reply,
  );

  await ctx.answerCallbackQuery({ text: replyLabels[reply] });

  let firstError: unknown = null;

  try {
    for (const requestID of requestIDs) {
      const response = await opencodeClient.permission.reply({
        requestID,
        directory,
        reply,
      });

      if (!response.error) {
        // The OpenCode ask has been released. Leave this request's one-shot
        // handoff in place for the resumed RustDesk tool to consume.
        preparedRustDeskHandoffs.delete(requestID);
        continue;
      }

      if (requestIDs.length > 1 && isPermissionRequestNotFound(response.error)) {
        // OpenCode can coalesce equivalent permission requests: replying to the
        // first may release a grouped sibling and make its explicit reply return
        // NotFound. Treat that as released too; deleting its handoff here races
        // the resumed tool.
        preparedRustDeskHandoffs.delete(requestID);
        logger.debug(
          `[PermissionHandler] Ignoring duplicate permission reply miss: requestID=${requestID}`,
        );
        continue;
      }

      firstError ??= response.error;
    }
  } catch (error) {
    await discardPreparedRustDeskHandoffs(preparedRustDeskHandoffs);
    throw error;
  }

  if (firstError) {
    await discardPreparedRustDeskHandoffs(preparedRustDeskHandoffs);
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

  if (reply === "always" && permissionType) {
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
