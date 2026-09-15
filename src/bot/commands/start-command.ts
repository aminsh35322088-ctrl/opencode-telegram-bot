import { Context } from "grammy";
import { pinnedMessageManager } from "../pinned/pinned-message-manager.js";
import { keyboardManager } from "../keyboards/keyboard-manager.js";
import { clearSession } from "../../app/services/session-service.js";
import * as settingsStore from "../../app/stores/settings-store.js";
import { foregroundSessionState } from "../../app/managers/foreground-session-state-manager.js";
import { abortCurrentOperation } from "./abort-command.js";
import { assistantRunState } from "../../app/managers/assistant-run-state-manager.js";
import { detachAttachedSession } from "../../app/services/attach-service.js";
import { clearPausedSession } from "../../app/managers/paused-session-manager.js";
import { getBotUpdateNotice, markBotVersionNotified } from "../../app/services/version-info-service.js";
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

function isPrivateBotTopicMode(ctx: Context): boolean {
  const chat = ctx.chat as { type?: string } | undefined;
  const botInfo = ctx.me as { has_topics_enabled?: boolean } | undefined;
  return chat?.type === "private" && botInfo?.has_topics_enabled === true;
}

export async function startCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (typeof chatId !== "number") return;

  const inboundThreadId = ctx.message?.message_thread_id;
  const isInTopic = typeof inboundThreadId === "number" && inboundThreadId > 1;
  const binding = isInTopic ? await findTelegramTopicBindingByThread(chatId, inboundThreadId) : null;
  const isSupergroupForum = Boolean((ctx.chat as { is_forum?: boolean }).is_forum);
  const isPrivateTopicMode = isPrivateBotTopicMode(ctx);
  const isTopicMode = isSupergroupForum || isPrivateTopicMode || isInTopic || keyboardManager.isTopicMode(chatId);

  await normalizeStartContext(ctx);
  logger.info(`[TelegramKeyboard] /start mode detection: chat=${chatId}, isInTopic=${isInTopic}, isSupergroupForum=${isSupergroupForum}, isPrivateTopicMode=${isPrivateTopicMode}, topicMode=${keyboardManager.isTopicMode(chatId)}`);
  if (isInTopic) logger.info(`[TelegramTopics] /start from ${binding ? "bound" : "unbound"} Topic; restoring Topic Mode controls in the current topic context: chat=${chatId}, thread=${inboundThreadId}`);

  if (!pinnedMessageManager.isInitialized()) pinnedMessageManager.initialize(ctx.api, chatId);
  keyboardManager.initialize(ctx.api, chatId);

  if (!isInTopic && !isTopicMode) {
    await abortCurrentOperation(ctx, { notifyUser: false });
    detachAttachedSession("start_command_reset");
    foregroundSessionState.clearAll("start_command_reset");
    assistantRunState.clearAll("start_command_reset");
    clearPausedSession();
    keyboardManager.setPaused(false);
    clearSession();
    settingsStore.clearProject();
    keyboardManager.clearContext();
    await pinnedMessageManager.clear();
    if (pinnedMessageManager.getContextLimit() === 0) await pinnedMessageManager.refreshContextLimit();
  }

  await sendBotUpdateNotice(ctx);

  // /start in All/root is intentionally a replacement, not an edit/refresh.
  // The keyboard manager creates and pins the new root panel first, persists it
  // as the canonical Main anchor, then retires the previous bot-owned anchor.
  // If any creation/pin/persistence step fails, the previous good panel remains.
  if (!isInTopic) {
    const replaced = await keyboardManager.replaceMainInlineKeyboard(chatId);
    // In Topic Mode the All/root input area must show the Main controls
    // keyboard (Telegram reply keyboards are chat-scoped and the AI Topic
    // controls were just retired by this root /start).
    if (isTopicMode) {
      await keyboardManager.applyMainScopeReplyKeyboardOnce(chatId).catch((error) => {
        logger.warn(`[TelegramKeyboard] /start failed to apply Main controls Reply Keyboard in All/root: chat=${chatId}`, error);
      });
    }
    logger.info(`[TelegramKeyboard] /start root Main replacement finished: chat=${chatId}, success=${replaced}, mode=${isTopicMode ? "topic-aware" : "normal"}`);
    return;
  }

  // A /start typed inside a coding Topic must not create/pin a panel in that
  // Topic. Refresh the canonical Main/All anchor through the unscoped API only.
  await keyboardManager.sendMainInlineKeyboard(chatId, undefined, true);
  logger.info(`[TelegramKeyboard] /start inside Topic refreshed canonical Main/All navigation without Topic pin leakage: chat=${chatId}, thread=${inboundThreadId}`);
}
