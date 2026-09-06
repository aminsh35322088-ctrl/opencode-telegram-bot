import { Context } from "grammy";
import { createMainKeyboard } from "../keyboards/main-reply-keyboard.js";
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

/**
 * /start is a Main/General command, never a Topic command.
 *
 * Telegram may deliver /start with a message_thread_id when the bot's private
 * threaded mode still allows users to create topics. An unbound thread in
 * this case is Telegram-created UI state, not an OpenCode session.
 *
 * We must NOT delete that thread here: deleting the thread underneath the
 * client can make the bot conversation disappear from the chat list. The
 * server-side behavior is intentionally non-destructive: keep the incoming
 * Topic untouched, do not attach an OpenCode session to it, and render the
 * Main UI through a normal message to General.
 */
async function normalizeStartContext(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id;
  if (typeof chatId !== "number" || typeof threadId !== "number" || threadId <= 1) return;

  const binding = await findTelegramTopicBindingByThread(chatId, threadId);
  if (binding) {
    logger.info(
      `[TelegramTopics] /start received inside bound AI Topic; leaving Topic intact and treating /start as General navigation only: chat=${chatId}, thread=${threadId}, session=${binding.sessionId}`,
    );
    return;
  }

  logger.info(
    `[TelegramTopics] /start arrived in an unbound Telegram Topic; leaving the Topic untouched and returning the Main UI to native General: chat=${chatId}, thread=${threadId}`,
  );
}

async function sendBotUpdateNotice(ctx: Context): Promise<void> {
  const notice = await getBotUpdateNotice();
  if (!notice) return;
  const chatId = ctx.chat!.id;
  const opts: Record<string, unknown> = { parse_mode: "HTML" };
  await ctx.api.sendMessage(chatId, `🚀 <b>Bot updated</b>\n\nv${notice.previousVersion} → <b>v${notice.currentVersion}</b>\n\n🟢 The new Telegram Bot version is installed and ready to use.`, opts);
  if (notice.changelog) await ctx.api.sendMessage(chatId, `📋 Changelog v${notice.currentVersion}\n\n${notice.changelog}`, opts);
  await markBotVersionNotified(notice.currentVersion);
}

export async function startCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (typeof chatId !== "number") return;

  const inboundThreadId = ctx.message?.message_thread_id;
  const isInTopic = typeof inboundThreadId === "number" && inboundThreadId > 1;
  const binding = isInTopic ? await findTelegramTopicBindingByThread(chatId, inboundThreadId) : null;

  await normalizeStartContext(ctx);

  if (isInTopic) {
    if (binding) {
      logger.info(
        `[TelegramTopics] /start from bound AI Topic is navigation-only; no session/run state will be changed: chat=${chatId}, thread=${inboundThreadId}, session=${binding.sessionId}`,
      );
    } else {
      logger.info(
        `[TelegramTopics] /start from unbound Telegram Topic is navigation-only; no Topic/session state will be created or deleted: chat=${chatId}, thread=${inboundThreadId}`,
      );
    }
  }

  if (!pinnedMessageManager.isInitialized()) pinnedMessageManager.initialize(ctx.api, chatId);
  keyboardManager.initialize(ctx.api, chatId);

  if (!isInTopic) {
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

  // Always send the Main reply keyboard explicitly from /start. This also
  // restores it after the user previously hid the keyboard with the custom
  // Hide Keyboard control. Never attach the message to a Telegram Topic.
  const mainKeyboard = createMainKeyboard(currentModel, {
    paused: false,
    running: false,
    isTopic: false,
  });
  const sendOptions: Record<string, unknown> = { parse_mode: "HTML", reply_markup: mainKeyboard };
  await ctx.api.sendMessage(chatId, text, sendOptions);
}
