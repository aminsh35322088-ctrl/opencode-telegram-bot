import type { Bot, Context } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { findTelegramTopicBindingBySession, listTelegramTopicBindings } from "../../app/services/telegram-topic-store.js";
import { getTopicRuntimeState, initializeTopicRuntimeState } from "../../app/stores/topic-runtime-state-store.js";
import { runInTopicRuntimeContext } from "../../app/services/topic-runtime-context.js";
import { setCurrentSession } from "../../app/services/session-service.js";
import { attachToSession } from "../../app/services/attach-service.js";
import { keyboardManager } from "../keyboards/keyboard-manager.js";
import { ensureActiveInlineMenu, appendInlineMenuCancelButton } from "../menus/inline-menu.js";
import { buildSessionDeleteConfirmationKeyboard, buildSessionPreviewKeyboard, buildSessionSelectionMenuView, loadSessionPreviewItems, formatSessionPreview, parseSessionContinueCallback, parseSessionDeleteCallback, parseSessionDeleteConfirmCallback, parseSessionPageCallback, parseSessionPreviewCallback, SESSION_BACK_CALLBACK, SESSION_DELETE_CALLBACK_PREFIX } from "../menus/session-selection-menu.js";
import { deleteTelegramTopicSession } from "../../app/services/telegram-topic-delete-service.js";
import { clearAllInteractionState } from "../../app/managers/interaction-manager.js";
import { isForegroundBusy } from "../../app/services/run-control-service.js";
import { replyBusyBlocked } from "../messages/busy-blocked-renderer.js";
import { getStoredAgent } from "../../app/services/agent-selection-service.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { getCompactOutputMode } from "../../app/stores/settings-store.js";
import { logger } from "../../utils/logger.js";

export interface SessionPreviewDeps { bot: Bot<Context>; ensureEventSubscription: (directory: string) => Promise<void>; }
function buildTopicHistoryPage(bindings: Awaited<ReturnType<typeof listTelegramTopicBindings>>, page: number, pageSize: number) {
  const start = page * pageSize; const items = bindings.filter((binding) => binding.chatId === bindings[0]?.chatId).slice(start, start + pageSize);
  return { sessions: items.map((binding) => ({ id: binding.sessionId, title: binding.title ?? `Topic ${binding.threadId}`, directory: binding.directory, time: { created: Date.parse(binding.createdAt) || Date.now() } })), hasNext: start + pageSize < bindings.filter((binding) => binding.chatId === bindings[0]?.chatId).length, page };
}
async function refreshTopicHistory(ctx: Context, page = 0): Promise<void> {
  const chatId = ctx.chat?.id; if (chatId === undefined) return;
  const all = (await listTelegramTopicBindings()).filter((binding) => binding.chatId === chatId).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const pageSize = 8; const total = all.length; const start = page * pageSize; const sessionPage = { sessions: all.slice(start, start + pageSize).map((binding) => ({ id: binding.sessionId, title: binding.title ?? `Topic ${binding.threadId}`, directory: binding.directory, time: { created: Date.parse(binding.updatedAt) || Date.now() } })), hasNext: start + pageSize < total, page };
  const view = buildSessionSelectionMenuView(sessionPage, pageSize); appendInlineMenuCancelButton(view.keyboard, "session"); await ctx.editMessageText(`🗂 Topic History\n\n${view.text.replace(/^🕘\s*/u, "")}`, { reply_markup: view.keyboard });
}

export async function handleSessionPreviewCallback(ctx: Context, deps: SessionPreviewDeps): Promise<boolean> {
  const data = ctx.callbackQuery?.data; if (!data) return false;
  const previewId = parseSessionPreviewCallback(data); const continueId = parseSessionContinueCallback(data); const deleteId = parseSessionDeleteCallback(data); const deleteConfirmId = parseSessionDeleteConfirmCallback(data); const page = parseSessionPageCallback(data); const isBack = data === SESSION_BACK_CALLBACK;
  if (!previewId && !continueId && !deleteId && !deleteConfirmId && page === null && !isBack && data !== "session:no") return false;
  if (isForegroundBusy() && !deleteConfirmId) { await replyBusyBlocked(ctx); return true; }
  if (!(await ensureActiveInlineMenu(ctx, "session"))) return true;
  const chatId = ctx.chat?.id; if (chatId === undefined) return true;
  try {
    if (isBack || data === "session:no") { await ctx.answerCallbackQuery(); await refreshTopicHistory(ctx, 0); return true; }
    if (page !== null) { await ctx.answerCallbackQuery(); await refreshTopicHistory(ctx, page); return true; }
    const sessionId = previewId ?? continueId ?? deleteId ?? deleteConfirmId; if (!sessionId) return true;
    const binding = await findTelegramTopicBindingBySession(chatId, sessionId); if (!binding) { await ctx.answerCallbackQuery({ text: "Topic no longer exists", show_alert: true }); await refreshTopicHistory(ctx, 0); return true; }

    if (deleteConfirmId) {
      await deleteTelegramTopicSession(ctx.api, binding);
      await ctx.answerCallbackQuery({ text: "Topic deleted" });
      await refreshTopicHistory(ctx, 0);
      return true;
    }
    if (deleteId) {
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(`🗑 Delete Topic?\n\n💬 ${binding.title ?? "Telegram Topic"}\n\nThis permanently closes the Topic and removes its Session, workspace, files and History entry.`, { reply_markup: buildSessionDeleteConfirmationKeyboard(binding.sessionId) });
      return true;
    }
    if (previewId) {
      const items = await loadSessionPreviewItems(binding.sessionId, binding.directory, 10);
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(formatSessionPreview(binding.title ?? "Telegram Topic", items), { reply_markup: buildSessionPreviewKeyboard(binding.sessionId) });
      return true;
    }

    const runtime = await getTopicRuntimeState(binding.chatId, binding.threadId);
    const session = runtime?.session ?? { id: binding.sessionId, title: binding.title ?? "Telegram Topic", directory: binding.directory };
    await initializeTopicRuntimeState(binding.chatId, binding.threadId, { session, model: runtime?.model ?? getStoredModel(), agent: runtime?.agent ?? getStoredAgent(), compactOutputMode: runtime?.compactOutputMode ?? getCompactOutputMode() });
    await runInTopicRuntimeContext({ chatId: binding.chatId, threadId: binding.threadId, sessionId: binding.sessionId }, async () => {
      setCurrentSession(session);
      clearAllInteractionState("topic_history_continue");
      keyboardManager.bindTopic(ctx.api, binding.chatId, binding.threadId, binding.sessionId);
      if (runtime?.model) keyboardManager.updateModel(runtime.model, binding.sessionId);
      if (runtime?.agent) keyboardManager.updateAgent(runtime.agent, binding.sessionId);
      await attachToSession({ bot: deps.bot, chatId: binding.chatId, session, ensureEventSubscription: deps.ensureEventSubscription });
      await deps.ensureEventSubscription(binding.directory);
    });
    await ctx.answerCallbackQuery({ text: "Topic ready" });
    await ctx.editMessageText(`✅ Topic ready\n\n💬 ${binding.title ?? "Telegram Topic"}\n\nThe conversation is attached to the original Topic. A message was sent there to bring it to the front.`, { reply_markup: { inline_keyboard: [[{ text: "🗂 Back to History", callback_data: "session:back" }]] } });
    await ctx.api.sendMessage(binding.chatId, `▶️ <b>Continue</b>\n\n${binding.title ?? "Telegram Topic"} is ready. Continue your conversation here.`, { parse_mode: "HTML", message_thread_id: binding.threadId });
    logger.info(`[TopicHistory] Continued Topic: chat=${binding.chatId}, thread=${binding.threadId}, session=${binding.sessionId}`);
    return true;
  } catch (error) { logger.error("[TopicHistory] Error handling Topic History callback:", error); await ctx.answerCallbackQuery({ text: "Could not process Topic History", show_alert: true }).catch(() => {}); return true; }
}
