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
import { BOT_VERSION, getBotUpdateNotice, getOpenCodeVersion, markBotVersionNotified } from "../../app/services/version-info-service.js";
import { findTelegramTopicBindingByThread } from "../../app/services/telegram-topic-store.js";
import { getMainTelegramTopic, saveMainTelegramTopic } from "../../app/services/telegram-main-topic-store.js";
import { logger } from "../../utils/logger.js";

/**
 * Telegram's General forum topic is native and cannot be created by the bot.
 * Bot API messages sent without message_thread_id are delivered to General.
 * Keep thread id 1 only as persisted metadata; never pass it to sendMessage.
 */
async function ensureMainTopic(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (typeof chatId !== "number") return;

  const incomingThreadId = ctx.message?.message_thread_id;
  if (typeof incomingThreadId === "number" && incomingThreadId > 1) {
    const incomingBinding = await findTelegramTopicBindingByThread(chatId, incomingThreadId);
    if (incomingBinding) {
      logger.info(`[TelegramTopics] /start reset requested inside bound AI topic: chat=${chatId}, thread=${incomingThreadId}, session=${incomingBinding.sessionId}`);
      return;
    }
    logger.warn(`[TelegramTopics] /start arrived in an unbound topic; using native General context: chat=${chatId}, incomingThread=${incomingThreadId}`);
  }

  const existing = await getMainTelegramTopic(chatId);
  if (existing) return;

  await saveMainTelegramTopic(chatId, 1, "General");
  logger.info(`[TelegramTopics] Registered Telegram native General topic metadata: chat=${chatId}, thread=1`);
}

async function sendBotUpdateNotice(ctx: Context): Promise<void> {
  const notice = await getBotUpdateNotice();
  if (!notice) return;
  await ctx.api.sendMessage(ctx.chat!.id, `🚀 <b>Bot updated</b>\n\nv${notice.previousVersion} → <b>v${notice.currentVersion}</b>\n\n🟢 The new Telegram Bot version is installed and ready to use.`, { parse_mode: "HTML" });
  if (notice.changelog) await ctx.api.sendMessage(ctx.chat!.id, `📋 Changelog v${notice.currentVersion}\n\n${notice.changelog}`);
  await markBotVersionNotified(notice.currentVersion);
}

export async function startCommand(ctx: Context): Promise<void> {
  await ensureMainTopic(ctx);
  if (ctx.chat) {
    if (!pinnedMessageManager.isInitialized()) pinnedMessageManager.initialize(ctx.api, ctx.chat.id);
    // Do not pass General's synthetic id=1 here. Telegram routes messages sent
    // without message_thread_id to the native General topic.
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
  const modelDisplay = currentModel.providerID && currentModel.modelID ? formatModelForDisplay(currentModel.providerID, currentModel.modelID, currentModel.name) : "Not configured";
  const openCodeVersion = await getOpenCodeVersion();
  const text = [
    "⚡ <b>OpenCode Telegram</b>", "", "🟢 <b>Ready</b>", `🤖 Bot <b>v${BOT_VERSION}</b>`, `🧠 OpenCode <b>v${openCodeVersion}</b>`, `🤖 ${modelDisplay}`, `🛠️ ${currentAgent}`, "", "Build, debug and control OpenCode directly from Telegram.", "", "💬 Use New Chat to start a fresh coding Topic, or open an existing Topic to continue its session.",
  ].join("\n");
  await sendBotUpdateNotice(ctx);
  if (ctx.chat) {
    await ctx.api.sendMessage(ctx.chat.id, text, {
      parse_mode: "HTML",
      reply_markup: createMainKeyboard(currentAgent, currentModel, contextInfo ?? undefined, variantName, [], false, false),
    });
  }
}
