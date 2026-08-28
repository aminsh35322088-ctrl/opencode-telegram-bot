import { Context } from "grammy";
import { createMainKeyboard } from "../keyboards/main-reply-keyboard.js";
import { getStoredAgent } from "../../app/services/agent-selection-service.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { formatVariantForButton } from "../../app/services/variant-selection-service.js";
import { pinnedMessageManager } from "../pinned/pinned-message-manager.js";
import { keyboardManager } from "../keyboards/keyboard-manager.js";
import { clearSession } from "../../app/services/session-service.js";
import { clearProject } from "../../app/stores/settings-store.js";
import { foregroundSessionState } from "../../app/managers/foreground-session-state-manager.js";
import { abortCurrentOperation } from "./abort-command.js";
import { assistantRunState } from "../../app/managers/assistant-run-state-manager.js";
import { detachAttachedSession } from "../../app/services/attach-service.js";
import { clearPausedSession } from "../../app/managers/paused-session-manager.js";
import { formatModelForDisplay } from "../../app/types/model.js";

export async function startCommand(ctx: Context): Promise<void> {
  if (ctx.chat) {
    if (!pinnedMessageManager.isInitialized()) pinnedMessageManager.initialize(ctx.api, ctx.chat.id);
    keyboardManager.initialize(ctx.api, ctx.chat.id);
  }

  await abortCurrentOperation(ctx, { notifyUser: false });
  detachAttachedSession("start_command_reset");
  foregroundSessionState.clearAll("start_command_reset");
  assistantRunState.clearAll("start_command_reset");
  clearPausedSession();
  keyboardManager.setPaused(false);
  clearSession();
  clearProject();
  keyboardManager.clearContext();
  await pinnedMessageManager.clear();

  if (pinnedMessageManager.getContextLimit() === 0) await pinnedMessageManager.refreshContextLimit();

  const currentAgent = getStoredAgent();
  const currentModel = getStoredModel();
  const variantName = formatVariantForButton(currentModel.variant || "default");
  const contextInfo =
    pinnedMessageManager.getContextInfo() ??
    (pinnedMessageManager.getContextLimit() > 0
      ? { tokensUsed: 0, tokensLimit: pinnedMessageManager.getContextLimit() }
      : null);

  keyboardManager.updateAgent(currentAgent);
  keyboardManager.updateModel(currentModel);
  if (contextInfo) keyboardManager.updateContext(contextInfo.tokensUsed, contextInfo.tokensLimit);

  const modelDisplay = currentModel.providerID && currentModel.modelID
    ? formatModelForDisplay(currentModel.providerID, currentModel.modelID)
    : "Not configured";

  const text = [
    "⚡ <b>OpenCode</b>",
    "",
    "🟢 <b>Ready</b>",
    `🤖 ${modelDisplay}`,
    `🛠️ ${currentAgent}`,
    "",
    "Build, debug and control OpenCode directly from Telegram.",
    "",
    "💬 Start a fresh chat or open 🕘 History to continue an existing conversation.",
  ].join("\n");

  const keyboard = createMainKeyboard(currentAgent, currentModel, contextInfo ?? undefined, variantName, [], false);
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
}
