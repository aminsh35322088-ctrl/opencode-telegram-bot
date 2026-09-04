import { processUserPrompt, type ProcessPromptDeps } from "./prompt.js";
import { resumePausedChatWithPrompt } from "../commands/pause-command.js";
import type { Context } from "grammy";
import { logger } from "../../utils/logger.js";
import { isReplyKeyboardButtonText } from "../message-patterns.js";
import { formatModelForButton } from "../../app/types/model.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { getCurrentSession } from "../../app/services/session-service.js";
import { isChatPaused } from "../../app/managers/paused-session-manager.js";
import { getTopicRuntimeContext, runInTopicRuntimeContext, type TopicRuntimeContext } from "../../app/services/topic-runtime-context.js";

const TELEGRAM_SPLIT_CHUNK_MIN_LENGTH = 4000;

type PromptRouteKey = string;

interface PendingPrompt {
  texts: string[];
  ctx: Context;
  deps: ProcessPromptDeps;
  timer: ReturnType<typeof setTimeout>;
  topicContext: TopicRuntimeContext | null;
}

// Pending prompts are isolated by Telegram chat + topic thread + bound session.
// Never key this buffer by chat alone: a timer callback runs outside the
// original AsyncLocalStorage scope, and a chat can contain several Topics.
const pendingByRoute = new Map<PromptRouteKey, PendingPrompt>();

function getPromptRouteKey(chatId: number, topicContext: TopicRuntimeContext | null): PromptRouteKey {
  if (!topicContext) return `${chatId}:main`;
  return `${chatId}:topic:${topicContext.threadId}:session:${topicContext.sessionId ?? "unbound"}`;
}

function isReservedReplyKeyboardText(text: string): boolean {
  const model = getStoredModel();
  const known = new Set<string>();
  if (model.providerID && model.modelID) known.add(formatModelForButton(model.providerID, model.modelID, model.name));
  return isReplyKeyboardButtonText(text, known);
}

function runWithCapturedTopicContext<T>(topicContext: TopicRuntimeContext | null, callback: () => T): T {
  return topicContext ? runInTopicRuntimeContext(topicContext, callback) : callback();
}

function flushPending(routeKey: PromptRouteKey): void {
  const pending = pendingByRoute.get(routeKey);
  if (!pending) return;

  pendingByRoute.delete(routeKey);
  clearTimeout(pending.timer);

  const { texts, ctx, deps, topicContext } = pending;
  const routeLabel = topicContext
    ? `chatId=${topicContext.chatId}, threadId=${topicContext.threadId}, session=${topicContext.sessionId ?? "unbound"}`
    : `chatId=${ctx.chat?.id ?? "unknown"}, main`;

  if (texts.length > 1) {
    logger.info(
      `[Bot] Merging ${texts.length} quick consecutive messages into one prompt (${routeLabel}, totalLength=${texts.reduce((sum, part) => sum + part.length, 0)})`,
    );
  } else {
    logger.debug(`[Bot] Flushing single pending prompt (${routeLabel})`);
  }

  // The timer executes after grammY's middleware chain has completed, so the
  // original AsyncLocalStorage context is gone. Restore the exact Topic
  // context captured when the message entered the router before touching any
  // session/project/model state.
  void runWithCapturedTopicContext(topicContext, () => processUserPrompt(ctx, texts.join("\n\n"), deps)).catch((err) => {
    logger.error(`[Bot] Failed to process merged prompt (${routeLabel})`, err);
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
  const topicContext = getTopicRuntimeContext();
  const routeKey = getPromptRouteKey(chatId, topicContext);

  // Reply-keyboard controls are reserved protocol messages, never Coding AI
  // input. This is a final safety net even if a Telegram/grammY matcher does
  // not consume a control before the prompt router.
  if (isReservedReplyKeyboardText(text)) {
    logger.debug(`[Bot] Ignoring reply-keyboard control in prompt merger: ${routeKey}, text=${JSON.stringify(text)}`);
    return;
  }

  // A paused session accepts the next normal prompt as an implicit Resume.
  // Execute this inside the captured Topic context as well; otherwise a Topic
  // prompt could accidentally resume/check the main-chat session.
  const currentSession = getCurrentSession();
  if (currentSession && isChatPaused(currentSession.id)) {
    logger.info(`[Pause] Treating incoming prompt as implicit resume: session=${currentSession.id}, ${routeKey}`);
    void runWithCapturedTopicContext(topicContext, () => resumePausedChatWithPrompt(ctx, text, deps)).catch((err) => {
      logger.error(`[Pause] Failed to resume paused chat from prompt (${routeKey})`, err);
    });
    return;
  }

  const existing = pendingByRoute.get(routeKey);

  if (mergeWindowMs <= 0 || (!existing && text.length < TELEGRAM_SPLIT_CHUNK_MIN_LENGTH)) {
    void runWithCapturedTopicContext(topicContext, () => processUserPrompt(ctx, text, deps)).catch((err) => {
      logger.error(`[Bot] Failed to process prompt (${routeKey})`, err);
    });
    return;
  }

  if (existing) {
    existing.texts.push(text);
    existing.ctx = ctx;
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => flushPending(routeKey), mergeWindowMs);
    logger.debug(`[Bot] Appended message to pending prompt (${routeKey}, parts=${existing.texts.length})`);
    return;
  }

  const timer = setTimeout(() => flushPending(routeKey), mergeWindowMs);
  pendingByRoute.set(routeKey, { texts: [text], ctx, deps, timer, topicContext });
  logger.debug(`[Bot] Started prompt merge window (${routeKey}, mergeWindowMs=${mergeWindowMs})`);
}

/** Immediately flush any buffered prompt for the chat and optional Topic. */
export function flushPendingPrompt(chatId: number, threadId?: number): void {
  if (typeof threadId === "number") {
    for (const [routeKey, pending] of pendingByRoute) {
      if (pending.topicContext?.chatId === chatId && pending.topicContext.threadId === threadId) flushPending(routeKey);
    }
    return;
  }

  for (const [routeKey, pending] of pendingByRoute) {
    if (pending.ctx.chat?.id === chatId && !pending.topicContext) flushPending(routeKey);
  }
}

/** Test helper: clears all buffered prompts and their timers. */
export function __resetMessageMergerForTests(): void {
  for (const pending of pendingByRoute.values()) clearTimeout(pending.timer);
  pendingByRoute.clear();
}
