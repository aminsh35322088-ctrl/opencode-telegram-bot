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
import { BOT_VERSION, getBotUpdateNotice, getOpenCodeVersion } from "../../app/services/version-info-service.js";

async function sendBotUpdateNotice(ctx: Context): Promise<void> {
  const notice = await getBotUpdateNotice();
  if (!notice) return;

  await ctx.reply(
    `🚀 Bot updated\n\nv${notice.previousVersion} → <b>v${notice.currentVersion}</b>\n\n🟢 The new Telegram Bot version is installed and ready to use.`,
    { parse_mode: "HTML" },
  );

  if (notice.changelog) {
    await ctx.reply(`📋 Changelog v${notice.currentVersion}\n\n${notice.changelog}`);
  }
}

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
  const contextInfo = pinnedMessageManager.getContextInfo() ?? (pinnedMessageManager.getContextLimit() > 0 ? { tokensUsed: 0, tokensLimit: pinnedMessageManager.getContextLimit() } : null);
  keyboardManager.updateAgent(currentAgent);
  keyboardManager.updateModel(currentModel);
  if (contextInfo) keyboardManager.updateContext(contextInfo.tokensUsed, contextInfo.tokensLimit);

  const modelDisplay = currentModel.providerID && currentModel.modelID ? formatModelForDisplay(currentModel.providerID, currentModel.modelID) : "Not configured";
  const openCodeVersion = await getOpenCodeVersion();
  const text = [
    "⚡ <b>OpenCode Telegram</b>",
    "",
    "🟢 <b>Ready</b>",
    `🤖 Bot <b>v${BOT_VERSION}</b>`,
    `🧠 OpenCode <b>v${openCodeVersion}</b>`,
    `🤖 ${modelDisplay}`,
    `🛠️ ${currentAgent}`,
    "",
    "Build, debug and control OpenCode directly from Telegram.",
    "",
    "💬 Start a fresh chat or open 🕘 History to continue an existing conversation.",
  ].join("\n");

  await sendBotUpdateNotice(ctx);
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: createMainKeyboard(currentAgent, currentModel, contextInfo ?? undefined, variantName, [], false, false) });
}
