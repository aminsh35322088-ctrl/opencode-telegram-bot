import { Context, InlineKeyboard } from "grammy";
import { permissionManager } from "../../app/managers/permission-manager.js";
import { summaryAggregator } from "../../app/managers/summary-aggregation-manager.js";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import { getCurrentProject, getCurrentSession } from "../../app/stores/settings-store.js";
import { opencodeClient } from "../../opencode/client.js";
import { logger } from "../../utils/logger.js";
import type { PermissionRequest } from "../../app/types/permission.js";
import type { I18nKey } from "../../i18n/en.js";
import { t } from "../../i18n/index.js";

const PERMISSION_NAME_KEYS: Record<string, I18nKey> = {
  bash: "permission.name.bash",
  edit: "permission.name.edit",
  write: "permission.name.write",
  read: "permission.name.read",
  webfetch: "permission.name.webfetch",
  websearch: "permission.name.websearch",
  glob: "permission.name.glob",
  grep: "permission.name.grep",
  list: "permission.name.list",
  task: "permission.name.task",
  lsp: "permission.name.lsp",
  external_directory: "permission.name.external_directory",
};

const PERMISSION_EMOJIS: Record<string, string> = {
  bash: "⚡",
  edit: "✏️",
  write: "📝",
  read: "📖",
  webfetch: "🌐",
  websearch: "🔍",
  glob: "📁",
  grep: "🔎",
  list: "📂",
  task: "⚙️",
  lsp: "🔧",
  external_directory: "📁",
};

export function clearPermissionInteraction(reason: string): void {
  const state = interactionManager.getSnapshot();
  if (state?.kind === "permission") {
    interactionManager.clear(reason);
  }
}

export function syncPermissionInteractionState(metadata: Record<string, unknown> = {}): void {
  const pendingCount = permissionManager.getPendingCount();

  if (pendingCount === 0) {
    clearPermissionInteraction("permission_no_pending_requests");
    return;
  }

  const nextMetadata: Record<string, unknown> = {
    pendingCount,
    ...metadata,
  };

  const state = interactionManager.getSnapshot();
  if (state?.kind === "permission") {
    interactionManager.transition({
      expectedInput: "callback",
      metadata: nextMetadata,
    });
    return;
  }

  interactionManager.start({
    kind: "permission",
    expectedInput: "callback",
    metadata: nextMetadata,
  });
}

async function autoAllowRememberedPermission(
  chatId: number,
  request: PermissionRequest,
): Promise<boolean> {
  if (!permissionManager.isAlwaysAllowed(chatId, request)) {
    return false;
  }

  const currentProject = getCurrentProject();
  const currentSession = getCurrentSession();
  const directory = currentSession?.directory ?? currentProject.worktree;
  if (!directory) {
    logger.warn(
      `[PermissionHandler] Cannot auto-allow remembered permission without a directory: requestID=${request.id}`,
    );
    return false;
  }

  try {
    const response = await opencodeClient.permission.reply({
      requestID: request.id,
      directory,
      reply: "always",
    });

    if (response.error) {
      logger.warn(
        `[PermissionHandler] Remembered Always Allow reply failed; showing prompt: requestID=${request.id}`,
        response.error,
      );
      return false;
    }

    logger.info(
      `[PermissionHandler] Auto-allowed remembered permission: chat=${chatId} permission=${request.permission} requestID=${request.id}`,
    );
    return true;
  } catch (error) {
    logger.warn(
      `[PermissionHandler] Remembered Always Allow reply threw; showing prompt: requestID=${request.id}`,
      error,
    );
    return false;
  }
}

/**
 * Show permission request message with inline buttons
 */
export async function showPermissionRequest(
  bot: Context["api"],
  chatId: number,
  request: PermissionRequest,
  generation: number = permissionManager.getGeneration(),
): Promise<void> {
  logger.debug(`[PermissionHandler] Showing permission request: ${request.permission}`);

  if (
    generation !== permissionManager.getGeneration() ||
    permissionManager.isResolved(request.id)
  ) {
    logger.debug(`[PermissionHandler] Skipping stale or already resolved request: ${request.id}`);
    return;
  }

  if (await autoAllowRememberedPermission(chatId, request)) {
    summaryAggregator.stopTypingIndicator();
    return;
  }

  const grouped = permissionManager.addEquivalentRequest(request, generation);
  if (grouped) {
    await bot
      .editMessageText(
        chatId,
        grouped.messageId,
        formatPermissionText(grouped.request, grouped.count),
        { reply_markup: buildPermissionKeyboard() },
      )
      .catch((err) => {
        logger.warn("[PermissionHandler] Failed to update grouped permission message:", err);
      });

    syncPermissionInteractionState({
      requestID: request.id,
      messageId: grouped.messageId,
      deduplicated: true,
      groupedCount: grouped.count,
    });
    summaryAggregator.stopTypingIndicator();
    return;
  }

  const text = formatPermissionText(request);
  const keyboard = buildPermissionKeyboard();

  try {
    const message = await bot.sendMessage(chatId, text, {
      reply_markup: keyboard,
    });

    logger.debug(`[PermissionHandler] Message sent, messageId=${message.message_id}`);
    if (!permissionManager.startPermission(request, message.message_id, generation)) {
      await bot.deleteMessage(chatId, message.message_id).catch((err) => {
        logger.warn(`[PermissionHandler] Failed to delete stale permission message:`, err);
      });
      return;
    }

    syncPermissionInteractionState({
      requestID: request.id,
      messageId: message.message_id,
    });

    summaryAggregator.stopTypingIndicator();
  } catch (err) {
    logger.error("[PermissionHandler] Failed to send permission message:", err);
    throw err;
  }
}

function formatPermissionText(request: PermissionRequest, groupedCount: number = 1): string {
  const emoji = PERMISSION_EMOJIS[request.permission] || "🔐";
  const nameKey = PERMISSION_NAME_KEYS[request.permission];
  const name = nameKey ? t(nameKey) : request.permission;

  let text = t("permission.header", { emoji, name });

  if (request.patterns.length > 0) {
    request.patterns.forEach((pattern) => {
      text += `• ${pattern}\n`;
    });
  }

  if (groupedCount > 1) {
    text += t("permission.grouped_count", { count: groupedCount });
  }

  return text;
}

function buildPermissionKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  keyboard.text(t("permission.button.allow"), "permission:once").row();
  keyboard.text(t("permission.button.always"), "permission:always").row();
  keyboard.text(t("permission.button.reject"), "permission:reject");

  return keyboard;
}
