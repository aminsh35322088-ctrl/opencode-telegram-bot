import { Context } from "grammy";
import { getStoredAgent, resolveProjectAgent } from "../../app/services/agent-selection-service.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { formatVariantForButton, formatVariantForDisplay, setCurrentVariant } from "../../app/services/variant-selection-service.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { failure, notify, switched } from "./feedback.js";
import { createMainKeyboard } from "../keyboards/main-reply-keyboard.js";
import { keyboardManager } from "../keyboards/keyboard-manager.js";
import { pinnedMessageManager } from "../pinned/pinned-message-manager.js";
import { clearActiveInlineMenu, ensureActiveInlineMenu } from "../menus/inline-menu.js";
import { getCurrentSession } from "../../app/services/session-service.js";

function getTopicThreadId(ctx: Context): number | undefined {
  const message = ctx.callbackQuery?.message;
  const threadId = message && "message_thread_id" in message
    ? (message as { message_thread_id?: number }).message_thread_id
    : undefined;
  return typeof threadId === "number" ? threadId : undefined;
}

export async function handleVariantSelect(ctx: Context): Promise<boolean> {
  const callbackQuery = ctx.callbackQuery;
  if (!callbackQuery?.data || !callbackQuery.data.startsWith("variant:")) return false;

  const isActiveMenu = await ensureActiveInlineMenu(ctx, "variant");
  if (!isActiveMenu) return true;
  logger.debug(`[VariantHandler] Received callback: ${callbackQuery.data}`);

  const threadId = getTopicThreadId(ctx);
  try {
    if (ctx.chat) keyboardManager.initialize(ctx.api, ctx.chat.id, getCurrentSession()?.id, threadId);
    if (pinnedMessageManager.getContextLimit() === 0) await pinnedMessageManager.refreshContextLimit();

    const variantId = callbackQuery.data.replace("variant:", "");
    const currentModel = getStoredModel();
    if (!currentModel.providerID || !currentModel.modelID) {
      logger.error("[VariantHandler] No model selected");
      await notify(ctx, "variant.model_not_selected_callback");
      return true;
    }

    setCurrentVariant(variantId);
    const updatedModel = getStoredModel();
    keyboardManager.updateModel(updatedModel);
    keyboardManager.updateVariant(variantId);

    const currentAgent = await resolveProjectAgent(getStoredAgent());
    const contextInfo = pinnedMessageManager.getContextInfo() ??
      (pinnedMessageManager.getContextLimit() > 0 ? { tokensUsed: 0, tokensLimit: pinnedMessageManager.getContextLimit() } : null);
    keyboardManager.updateAgent(currentAgent);
    if (contextInfo) keyboardManager.updateContext(contextInfo.tokensUsed, contextInfo.tokensLimit);

    const keyboard = createMainKeyboard(currentAgent, updatedModel, contextInfo ?? undefined, formatVariantForButton(variantId));
    clearActiveInlineMenu("variant_selected", ctx.chat?.id, threadId);
    await switched(ctx, t("variant.changed_message", { name: formatVariantForDisplay(variantId) }), keyboard);
    return true;
  } catch (err) {
    clearActiveInlineMenu("variant_select_error", ctx.chat?.id, threadId);
    logger.error("[VariantHandler] Error handling variant select:", err);
    await failure(ctx, "variant.change_error_callback");
    return true;
  }
}
