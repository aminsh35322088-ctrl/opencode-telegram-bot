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
import { logger } from "../../utils/logger.js";

/**
 * /start is a Main/General command, never a Topic command.
 *
 * Telegram can deliver /start with a message_thread_id when the client has
 * implicitly created a user Topic. That Topic is not an OpenCode session, so
 * it must not become the bot's Main context or inherit global session state.
 * We clean up an unbound accidental Topic and always answer in native General.
 */
async function normalizeStartContext(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id;
  if (typeof chatId !== "number" || typeof threadId !== "number" || threadId <= 1) return;

  const binding = await findTelegramTopicBindingByThread(chatId, threadId);
  if (binding) {
    logger.info(`[TelegramTopics] /start received inside bound AI Topic; keeping Topic intact and returning command to General: chat=${chatId}, thread=${threadId}, session=${binding.sessionId}`);
    return;
  }

  logger.warn(`[TelegramTopics] /start arrived in unbound Topic; deleting accidental Topic and returning to General: chat=${chatId}, thread=${threadId}`);
  try {
    await ctx.api.deleteForumTopic(chatId, threadId);
    logger.info(`[TelegramTopics] Deleted unbound /start Topic: chat=${chatId}, thread=${threadId}`);
  } catch (error) {
    logger.warn(`[TelegramTopics] Could not delete unbound /start Topic: chat=${chatId}, thread=${threadId}`, error);
  }
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

  // /start must never reset or abort an AI Topic. If Telegram delivered it
  // from a bound Topic, leave that Topic's session/run untouched and render
  // the Main UI in native General instead.
  if (isInTopic) {
    if (binding) {
      logger.info(`[TelegramTopics] /start from bound Topic is a navigation command only: chat=${chatId}, thread=${inboundThreadId}, session=${binding.sessionId}`);
    } else {
      logger.info(`[TelegramTopics] /start from unbound Topic normalized back to native General: chat=${chatId}, thread=${inboundThreadId}`);
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

  await sendBotUpdateNotice(ctx);
  const sendOptions: Record<string, unknown> = { parse_mode: "HTML", reply_markup: createMainKeyboard(currentAgent, currentModel, contextInfo ?? undefined, variantName, [], false, false) };
  // Intentionally omit message_thread_id: /start always belongs to native General.
  await ctx.api.sendMessage(chatId, text, sendOptions);
}
