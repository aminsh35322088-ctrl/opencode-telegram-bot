import type { Context } from "grammy";
import { MAX_QUEUED_PROMPTS, promptQueue } from "../../app/managers/prompt-queue-manager.js";
import { buildExternalUserInputNotification } from "../../app/services/external-user-input-service.js";
import { isForegroundBusy } from "../../app/services/run-control-service.js";
import { getCurrentSession, getPromptQueueEnabled } from "../../app/stores/settings-store.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { keyboardManager } from "../keyboards/keyboard-manager.js";
import { sendBotText } from "../messages/telegram-text.js";
import { isReplyKeyboardButtonText } from "../message-patterns.js";
import { processUserPrompt, type ProcessPromptDeps } from "./prompt.js";

let promptDeps: ProcessPromptDeps | null = null;
const queuedPromptContexts = new Map<string, Context>();
const dispatchInFlight = new Set<string>();

function queueKey(sessionId?: string): string { return sessionId ?? getCurrentSession()?.id ?? "__main__"; }
function isQueueablePromptText(text: string): boolean { const normalizedText = text.trim(); return Boolean(normalizedText) && !normalizedText.startsWith("/") && !isReplyKeyboardButtonText(text); }
export function initializePromptQueueDispatch(deps: ProcessPromptDeps): void { promptDeps = deps; }
export function shouldSuggestPromptQueue(text: string): boolean { return !getPromptQueueEnabled() && isQueueablePromptText(text); }
export async function tryEnqueuePrompt(ctx: Context, text: string): Promise<boolean> {
  if (!getPromptQueueEnabled() || !ctx.chat || !isQueueablePromptText(text)) return false;
  const key = queueKey(); queuedPromptContexts.set(key, ctx); const normalizedText = text.trim();
  if (promptQueue.isFull(key)) { logger.info(`[PromptQueue] Rejected prompt: queue is full (max=${MAX_QUEUED_PROMPTS}, session=${key})`); await replyWithKeyboard(ctx, t("queue.full", { max: String(MAX_QUEUED_PROMPTS) })); return true; }
  const queued = promptQueue.add(normalizedText, key); if (!queued) return false;
  logger.info(`[PromptQueue] Prompt queued while session is busy: session=${key}, size=${promptQueue.size(key)}/${MAX_QUEUED_PROMPTS}`);
  await replyWithKeyboard(ctx, t("queue.added", { count: String(promptQueue.size(key)), max: String(MAX_QUEUED_PROMPTS) })); return true;
}

export async function dispatchNextQueuedPrompt(sessionId?: string): Promise<void> {
  const key = queueKey(sessionId); const context = queuedPromptContexts.get(key);
  if (dispatchInFlight.has(key) || promptQueue.size(key) === 0 || !promptDeps || !context || isForegroundBusy()) return;
  dispatchInFlight.add(key);
  try {
    const item = promptQueue.takeNext(key); if (!item) return;
    const ctx = context; const deps = promptDeps; const notification = buildExternalUserInputNotification(item.text);
    if (notification && ctx.chat) { try { const keyboard = keyboardManager.getKeyboard(); await sendBotText({ api: ctx.api, chatId: ctx.chat.id, text: notification.text, rawFallbackText: notification.rawFallbackText, format: "markdown_v2", options: keyboard ? { reply_markup: keyboard } : {} }); } catch (err) { logger.error(`[PromptQueue] Failed to echo queued prompt: session=${key}`, err); } }
    logger.info(`[PromptQueue] Dispatching queued prompt: id=${item.id}, session=${key}, left=${promptQueue.size(key)}`);
    try { const dispatched = await processUserPrompt(ctx, item.text, deps); if (!dispatched) logger.warn(`[PromptQueue] Queued prompt was not dispatched: id=${item.id}, session=${key}`); } catch (err) { logger.error(`[PromptQueue] Failed to dispatch queued prompt: id=${item.id}, session=${key}`, err); }
  } finally { dispatchInFlight.delete(key); }
}
async function replyWithKeyboard(ctx: Context, text: string): Promise<void> { const keyboard = keyboardManager.getKeyboard(); await ctx.reply(text, keyboard ? { reply_markup: keyboard } : {}).catch((err) => logger.error("[PromptQueue] Failed to send queue reply:", err)); }
export function __resetPromptQueueDispatchForTests(): void { promptDeps = null; queuedPromptContexts.clear(); dispatchInFlight.clear(); }
