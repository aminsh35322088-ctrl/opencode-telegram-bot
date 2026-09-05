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

async function ensureMainTopic(ctx: Context): Promise<number | null> {
  const chatId = ctx.chat?.id;
  if (typeof chatId !== "number") return null;

  const incomingThreadId = ctx.message?.message_thread_id;
  if (typeof incomingThreadId === "number" && incomingThreadId > 1) {
    const incomingBinding = await findTelegramTopicBindingByThread(chatId, incomingThreadId);
    if (!incomingBinding) {
      try {
        await ctx.api.raw.editForumTopic({ chat_id: chatId, message_thread_id: incomingThreadId, name: "General" });
        logger.info(`[TelegramTopics] Renamed incoming /start topic to General: chat=${chatId}, thread=${incomingThreadId}`);
      } catch (error) {
        logger.warn(`[TelegramTopics] Could not rename incoming /start topic to General: chat=${chatId}, thread=${incomingThreadId}`, error);
      }
      await saveMainTelegramTopic(chatId, incomingThreadId, "General");
      logger.info(`[TelegramTopics] Adopted incoming /start topic as dedicated Main topic: chat=${chatId}, thread=${incomingThreadId}, title="General"`);
      return incomingThreadId;
    }
    logger.info(`[TelegramTopics] Ignoring /start inside bound AI topic: chat=${chatId}, thread=${incomingThreadId}, session=${incomingBinding.sessionId}`);
    return null;
  }

  const existing = await getMainTelegramTopic(chatId);
  if (existing) return existing.threadId;

  const result = await ctx.api.raw.createForumTopic({ chat_id: chatId, name: "General" });
  if (!result.message_thread_id) throw new Error("Telegram created the General topic without a message_thread_id");
  await saveMainTelegramTopic(chatId, result.message_thread_id, "General");
  logger.info(`[TelegramTopics] Created dedicated Main topic: chat=${chatId}, thread=${result.message_thread_id}, title="General"`);
  return result.message_thread_id;
}

async function sendBotUpdateNotice(ctx: Context, threadId?: number | null): Promise<void> {
  const notice = await getBotUpdateNotice();
  if (!notice) return;
  const options = { parse_mode: "HTML" as const, ...(threadId ? { message_thread_id: threadId } : {}) };
  await ctx.api.sendMessage(ctx.chat!.id, `🚀 <b>Bot updated</b>\n\nv${notice.previousVersion} → <b>v${notice.currentVersion}</b>\n\n🟢 The new Telegram Bot version is installed and ready to use.`, options);
  if (notice.changelog) await ctx.api.sendMessage(ctx.chat!.id, `📋 Changelog v${notice.currentVersion}\n\n${notice.changelog}`, threadId ? { message_thread_id: threadId } : {});
  await markBotVersionNotified(notice.currentVersion);
}

export async function startCommand(ctx: Context): Promise<void> {
  // Resolve the canonical Main thread before touching keyboard state. This
  // prevents a /start received while another Topic runtime is active from
  // initializing the Main keyboard under that Topic's transient context.
  const mainThreadId = await ensureMainTopic(ctx);

  if (ctx.chat) {
    if (!pinnedMessageManager.isInitialized()) pinnedMessageManager.initialize(ctx.api, ctx.chat.id);
    keyboardManager.initialize(ctx.api, ctx.chat.id, undefined, mainThreadId ?? undefined);
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
    "💬 Use New Chat to start a fresh coding Topic, or open an existing Topic to continue its session.",
  ].join("\n");
  await sendBotUpdateNotice(ctx, mainThreadId);
  if (ctx.chat) {
    await ctx.api.sendMessage(ctx.chat.id, text, {
      parse_mode: "HTML",
      reply_markup: createMainKeyboard(currentAgent, currentModel, contextInfo ?? undefined, variantName, [], false, false),
      ...(mainThreadId ? { message_thread_id: mainThreadId } : {}),
    });
  }
}
