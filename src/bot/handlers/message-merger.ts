import type { Context } from "grammy";
import { processUserPrompt, type ProcessPromptDeps } from "./prompt.js";
import { logger } from "../../utils/logger.js";
import { isReplyKeyboardButtonText } from "../message-patterns.js";
import { formatModelForButton } from "../../app/types/model.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";

const TELEGRAM_SPLIT_CHUNK_MIN_LENGTH = 4000;

interface PendingPrompt {
  texts: string[];
  ctx: Context;
  deps: ProcessPromptDeps;
  timer: ReturnType<typeof setTimeout>;
}

// Buffered plain-text prompts, keyed by chat id. Telegram delivers one long
// message (or one paste) as several consecutive updates; merging them here
// turns those chunks into a single OpenCode prompt.
const pendingByChat = new Map<number, PendingPrompt>();

function isReservedReplyKeyboardText(text: string): boolean {
  const model = getStoredModel();
  const known = new Set<string>();
  if (model.providerID && model.modelID) known.add(formatModelForButton(model.providerID, model.modelID, model.name));
  return isReplyKeyboardButtonText(text, known);
}

function flushPending(chatId: number): void {
  const pending = pendingByChat.get(chatId);
  if (!pending) {
    return;
  }

  pendingByChat.delete(chatId);
  clearTimeout(pending.timer);

  const { texts, ctx, deps } = pending;
  if (texts.length > 1) {
    logger.info(
      `[Bot] Merging ${texts.length} quick consecutive messages into one prompt (chatId=${chatId}, totalLength=${texts.reduce((sum, part) => sum + part.length, 0)})`,
    );
  } else {
    logger.debug(`[Bot] Flushing single pending prompt (chatId=${chatId})`);
  }

  void processUserPrompt(ctx, texts.join("\n\n"), deps).catch((err) => {
    logger.error(`[Bot] Failed to process merged prompt (chatId=${chatId})`, err);
  });
}

/**
 * Buffers a near-limit plain-text prompt so Telegram-split chunks are merged
 * into a single OpenCode prompt. Short messages are processed immediately
 * unless they follow a buffered chunk. Each new chunk restarts the wait window.
 *
 * Pass `mergeWindowMs <= 0` to disable merging and process the message
 * immediately.
 */
export function queuePromptForMerging(
  ctx: Context,
  text: string,
  deps: ProcessPromptDeps,
  mergeWindowMs: number,
): void {
  const chatId = ctx.chat!.id;

  // Reply-keyboard controls are reserved protocol messages, never Coding AI
  // input. This is a final safety net even if a Telegram/grammY matcher does
  // not consume a control before the prompt router.
  if (isReservedReplyKeyboardText(text)) {
    logger.debug(`[Bot] Ignoring reply-keyboard control in prompt merger: chatId=${chatId}, text=${JSON.stringify(text)}`);
    return;
  }

  const existing = pendingByChat.get(chatId);

  if (mergeWindowMs <= 0 || (!existing && text.length < TELEGRAM_SPLIT_CHUNK_MIN_LENGTH)) {
    void processUserPrompt(ctx, text, deps).catch((err) => {
      logger.error(`[Bot] Failed to process prompt (chatId=${chatId})`, err);
    });
    return;
  }

  if (existing) {
    existing.texts.push(text);
    existing.ctx = ctx;
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => flushPending(chatId), mergeWindowMs);
    logger.debug(
      `[Bot] Appended message to pending prompt (chatId=${chatId}, parts=${existing.texts.length})`,
    );
    return;
  }

  const timer = setTimeout(() => flushPending(chatId), mergeWindowMs);
  pendingByChat.set(chatId, { texts: [text], ctx, deps, timer });
  logger.debug(
    `[Bot] Started prompt merge window (chatId=${chatId}, mergeWindowMs=${mergeWindowMs})`,
  );
}

/** Immediately flush any buffered prompt for the chat (e.g. when a command arrives). */
export function flushPendingPrompt(chatId: number): void {
  flushPending(chatId);
}

/** Test helper: clears all buffered prompts and their timers. */
export function __resetMessageMergerForTests(): void {
  for (const pending of pendingByChat.values()) {
    clearTimeout(pending.timer);
  }
  pendingByChat.clear();
}
