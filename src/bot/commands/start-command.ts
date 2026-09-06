import { Context } from "grammy";
import { createMainInlineKeyboard, createTopicMainKeyboard } from "../keyboards/main-reply-keyboard.js";
import { getStoredAgent } from "../../app/services/agent-selection-service.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
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
import { logger } from "../../utils/logger.js";

async function normalizeStartContext(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id;
  if (typeof chatId !== "number" || typeof threadId !== "number" || threadId <= 1) return;
  const binding = await findTelegramTopicBindingByThread(chatId, threadId);
  if (binding) logger.info(`[TelegramTopics] /start received inside bound AI Topic; treating it as Topic navigation: chat=${chatId}, thread=${threadId}, session=${binding.sessionId}`);
  else logger.info(`[TelegramTopics] /start arrived in an unbound Telegram Topic: chat=${chatId}, thread=${threadId}`);
}

async function sendBotUpdateNotice(ctx: Context): Promise<void> {
  const notice = await getBotUpdateNotice();
  if (!notice) return;
  const chatId = ctx.chat!.id;
  const opts: Record<string, unknown> = { parse_mode: "HTML" };
  await ctx.api.sendMessage(chatId, `🚀 <b>Bot updated</b>\n\nv${notice.previousVersion} → <b>${notice.currentVersion}</b>\n\n🟢 The new Telegram Bot version is installed and ready to use.`, opts);
  if (notice.changelog) await ctx.api.sendMessage(chatId, `📋 Changelog v${notice.currentVersion}\n\n${notice.changelog}`, opts);
  await markBotVersionNotified(notice.currentVersion);
}

export async function startCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (typeof chatId !== "number") return;

  const inboundThreadId = ctx.message?.message_thread_id;
  const isInTopic = typeof inboundThreadId === "number" && inboundThreadId > 1;
  const binding = isInTopic ? await findTelegramTopicBindingByThread(chatId, inboundThreadId) : null;
  const isSupergroupForum = Boolean((ctx.chat as { is_forum?: boolean }).is_forum);
  // Private threaded bots expose topic capabilities through Bot API metadata, but that
  // capability alone must NOT switch an ordinary private chat into Topic Mode. Topic Mode
  // is entered explicitly by New Chat/topic creation and is tracked by keyboardManager.
  const isTopicMode = isSupergroupForum || isInTopic || keyboardManager.isTopicMode(chatId);

  await normalizeStartContext(ctx);
  logger.info(`[TelegramKeyboard] /start mode detection: chat=${chatId}, isInTopic=${isInTopic}, isSupergroupForum=${isSupergroupForum}, topicMode=${keyboardManager.isTopicMode(chatId)}`);
  if (isInTopic) logger.info(`[TelegramTopics] /start from ${binding ? "bound" : "unbound"} Topic; restoring Topic Mode keyboard in the current topic context: chat=${chatId}, thread=${inboundThreadId}`);

  if (!pinnedMessageManager.isInitialized()) pinnedMessageManager.initialize(ctx.api, chatId);
  keyboardManager.initialize(ctx.api, chatId);

  if (!isInTopic && !keyboardManager.isTopicMode(chatId)) {
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
  }

  const currentAgent = getStoredAgent();
  const currentModel = getStoredModel();
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

  await sendBotUpdateNotice(ctx);

  if (isTopicMode) {
    // In Topic Mode use the bottom Reply Keyboard. General/All is the native default
    // context; never force message_thread_id=1 because Telegram can reject it as missing.
    await keyboardManager.enterTopicMode(chatId);
    await ctx.api.sendMessage(chatId, text, {
      parse_mode: "HTML",
      reply_markup: createTopicMainKeyboard(currentModel),
    });
    logger.info(`[TelegramKeyboard] /start rendered Topic Mode ReplyKeyboard: chat=${chatId}, thread=General/native-default`);
    return;
  }

  // Normal private-chat mode keeps the original glass/inline keyboard untouched.
  const mainKeyboard = createMainInlineKeyboard(currentModel);
  const response = await ctx.api.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: mainKeyboard,
  });
  keyboardManager.setMainInlineMessage(chatId, response.message_id);
  logger.info(`[TelegramKeyboard] /start rendered Main InlineKeyboard: chat=${chatId}, thread=General/native-default, message=${response.message_id}`);
}
