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
import { getCurrentTopicSettings, updateCurrentTopicSettings, updateTopicDefaults } from "../../app/stores/settings-store.js";

function getTopicThreadId(ctx: Context): number | undefined {
  const message = ctx.callbackQuery?.message;
  const threadId = message && "message_thread_id" in message ? (message as { message_thread_id?: number }).message_thread_id : undefined;
  return typeof threadId === "number" ? threadId : undefined;
}

export async function handleVariantSelect(ctx: Context): Promise<boolean> {
  const callbackQuery = ctx.callbackQuery;
  if (!callbackQuery?.data || !callbackQuery.data.startsWith("variant:")) return false;
  if (!(await ensureActiveInlineMenu(ctx, "variant"))) return true;
  logger.debug(`[VariantHandler] Received callback: ${callbackQuery.data}`);

  const threadId = getTopicThreadId(ctx);
  try {
    const topic = getCurrentTopicSettings();
    const currentSession = getCurrentSession();
    const sessionId = topic && currentSession?.id ? currentSession.id : undefined;
    if (ctx.chat) keyboardManager.initialize(ctx.api, ctx.chat.id, sessionId, threadId);
    if (pinnedMessageManager.getContextLimit() === 0) await pinnedMessageManager.refreshContextLimit();

    const variantId = callbackQuery.data.replace("variant:", "");
    const currentModel = getStoredModel();
    if (!currentModel.providerID || !currentModel.modelID) {
      logger.error("[VariantHandler] No model selected");
      await notify(ctx, "variant.model_not_selected_callback");
      return true;
    }

    if (topic) {
      updateCurrentTopicSettings({ variant: variantId });
      updateCurrentTopicSettings({ model: { ...currentModel, variant: variantId } });
    } else {
      updateTopicDefaults({ variant: variantId });
      setCurrentVariant(variantId);
    }

    const updatedModel = getStoredModel();
    keyboardManager.updateModel(updatedModel, sessionId);
    keyboardManager.updateVariant(variantId, sessionId);
    const currentAgent = await resolveProjectAgent(getStoredAgent());
    const contextInfo = pinnedMessageManager.getContextInfo() ?? (pinnedMessageManager.getContextLimit() > 0 ? { tokensUsed: 0, tokensLimit: pinnedMessageManager.getContextLimit() } : null);
    keyboardManager.updateAgent(currentAgent, sessionId);
    if (contextInfo) keyboardManager.updateContext(contextInfo.tokensUsed, contextInfo.tokensLimit, sessionId);
    const keyboard = sessionId
      ? keyboardManager.getKeyboard(sessionId)
      : createMainKeyboard(currentAgent, updatedModel, contextInfo ?? undefined, formatVariantForButton(variantId));
    if (!keyboard) throw new Error(`No Topic keyboard state available for variant selection: session=${sessionId ?? "none"}`);
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
