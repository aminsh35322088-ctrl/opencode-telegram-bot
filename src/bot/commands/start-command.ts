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
 * Compute the target thread for /start responses.
 * - In a bound AI topic → respond in that topic
 * - In General or main chat → respond without thread id (routes to native General)
 * - In an unbound topic → respond in that topic (user should see feedback)
 */
function getStartTargetThreadId(ctx: Context): number | undefined {
  const threadId = ctx.message?.message_thread_id;
  if (typeof threadId === "number" && threadId > 1) return threadId;
  return undefined;
}

/**
 * Ensure the native General topic metadata is registered.
 * General (thread 1) is Telegram-native; never create it via API.
 */
async function ensureMainTopic(chatId: number): Promise<void> {
  const existing = await getMainTelegramTopic(chatId);
  if (existing) return;
  await saveMainTelegramTopic(chatId, 1, "General");
  logger.info(`[TelegramTopics] Registered Telegram native General topic metadata: chat=${chatId}, thread=1`);
}

async function sendBotUpdateNotice(ctx: Context, threadId?: number): Promise<void> {
  const notice = await getBotUpdateNotice();
  if (!notice) return;
  const chatId = ctx.chat!.id;
  const opts: Record<string, unknown> = { parse_mode: "HTML" };
  if (threadId) opts.message_thread_id = threadId;
  await ctx.api.sendMessage(chatId, `🚀 <b>Bot updated</b>\n\nv${notice.previousVersion} → <b>v${notice.currentVersion}</b>\n\n🟢 The new Telegram Bot version is installed and ready to use.`, opts);
  if (notice.changelog) await ctx.api.sendMessage(chatId, `📋 Changelog v${notice.currentVersion}\n\n${notice.changelog}`, opts);
  await markBotVersionNotified(notice.currentVersion);
}

export async function startCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (typeof chatId !== "number") return;

  const targetThreadId = getStartTargetThreadId(ctx);
  const inboundThreadId = ctx.message?.message_thread_id;
  const isInTopic = typeof inboundThreadId === "number" && inboundThreadId > 1;

  if (isInTopic) {
    const binding = await findTelegramTopicBindingByThread(chatId, inboundThreadId);
    if (binding) {
      logger.info(`[TelegramTopics] /start reset inside bound topic: chat=${chatId}, thread=${inboundThreadId}, session=${binding.sessionId}`);
    } else {
      logger.info(`[TelegramTopics] /start in unbound topic: chat=${chatId}, thread=${inboundThreadId}`);
    }
  }

  await ensureMainTopic(chatId);

  if (!pinnedMessageManager.isInitialized()) pinnedMessageManager.initialize(ctx.api, chatId);
  keyboardManager.initialize(ctx.api, chatId);

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
    "⚡ <b>OpenCode Telegram</b>", "", "🟢 <b>Ready</b>",
    `🤖 Bot <b>v${BOT_VERSION}</b>`, `🧠 OpenCode <b>v${openCodeVersion}</b>`,
    `🤖 ${modelDisplay}`, `🛠️ ${currentAgent}`, "",
    "Build, debug and control OpenCode directly from Telegram.", "",
    "💬 Use New Chat to start a fresh coding Topic, or open an existing Topic to continue its session.",
  ].join("\n");

  await sendBotUpdateNotice(ctx, targetThreadId);
  const sendOptions: Record<string, unknown> = { parse_mode: "HTML", reply_markup: createMainKeyboard(currentAgent, currentModel, contextInfo ?? undefined, variantName, [], false, false) };
  if (targetThreadId) sendOptions.message_thread_id = targetThreadId;
  await ctx.api.sendMessage(chatId, text, sendOptions);
}
