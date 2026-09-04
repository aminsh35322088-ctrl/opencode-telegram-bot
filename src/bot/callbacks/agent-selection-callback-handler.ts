import { Context } from "grammy";
import { selectAgent } from "../../app/services/agent-selection-service.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { formatVariantForButton } from "../../app/services/variant-selection-service.js";
import { getAgentDisplayName } from "../../app/types/agent.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { failure, switched } from "./feedback.js";
import { createMainKeyboard } from "../keyboards/main-reply-keyboard.js";
import { keyboardManager } from "../keyboards/keyboard-manager.js";
import { pinnedMessageManager } from "../pinned/pinned-message-manager.js";
import { clearActiveInlineMenu, ensureActiveInlineMenu } from "../menus/inline-menu.js";
import { getCurrentSession } from "../../app/services/session-service.js";
import { getCurrentTopicSettings, updateTopicDefaults } from "../../app/stores/settings-store.js";

function getTopicThreadId(ctx: Context): number | undefined {
  const message = ctx.callbackQuery?.message;
  const threadId = message && "message_thread_id" in message ? (message as { message_thread_id?: number }).message_thread_id : undefined;
  return typeof threadId === "number" ? threadId : undefined;
}

export async function handleAgentSelect(ctx: Context): Promise<boolean> {
  const callbackQuery = ctx.callbackQuery;
  if (!callbackQuery?.data || !callbackQuery.data.startsWith("agent:")) return false;
  if (!(await ensureActiveInlineMenu(ctx, "agent"))) return true;
  logger.debug(`[AgentHandler] Received callback: ${callbackQuery.data}`);
  try {
    const threadId = getTopicThreadId(ctx);
    if (ctx.chat) keyboardManager.initialize(ctx.api, ctx.chat.id, getCurrentSession()?.id, threadId);
    if (pinnedMessageManager.getContextLimit() === 0) await pinnedMessageManager.refreshContextLimit();

    const agentName = callbackQuery.data.replace("agent:", "");
    const topicSettings = getCurrentTopicSettings();
    if (topicSettings) selectAgent(agentName);
    else updateTopicDefaults({ agent: agentName });
    keyboardManager.updateAgent(agentName);

    const currentModel = getStoredModel();
    const contextInfo = pinnedMessageManager.getContextInfo() ?? (pinnedMessageManager.getContextLimit() > 0 ? { tokensUsed: 0, tokensLimit: pinnedMessageManager.getContextLimit() } : null);
    keyboardManager.updateModel(currentModel);
    if (contextInfo) keyboardManager.updateContext(contextInfo.tokensUsed, contextInfo.tokensLimit);
    const state = keyboardManager.getState();
    const variantName = state?.variantName ?? formatVariantForButton(currentModel.variant || "default");
    const keyboard = createMainKeyboard(agentName, currentModel, contextInfo ?? undefined, variantName);
    const displayName = getAgentDisplayName(agentName);
    clearActiveInlineMenu("agent_selected", ctx.chat?.id, threadId);
    await switched(ctx, t("agent.changed_message", { name: displayName }), keyboard);
    return true;
  } catch (err) {
    clearActiveInlineMenu("agent_select_error", ctx.chat?.id, getTopicThreadId(ctx));
    logger.error("[AgentHandler] Error handling agent select:", err);
    await failure(ctx, "agent.change_error_callback");
    return true;
  }
}
