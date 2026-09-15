import type { Context } from "grammy";
import type { ReactionType } from "grammy/types";
import { assistantRunState } from "../managers/assistant-run-state-manager.js";
import { lookupBotMessage } from "../managers/bot-message-registry.js";
import { promptQueue } from "../managers/prompt-queue-manager.js";
import { getCurrentSession } from "./session-service.js";
import { findTelegramTopicBindingBySessionId } from "./telegram-topic-store.js";
import { opencodeClient } from "../../opencode/client.js";
import { logger } from "../../utils/logger.js";

type ReactionIntent = "approve" | "dissatisfied" | "unclear" | "abort";
type AckEmoji = Extract<ReactionType, { type: "emoji" }>["emoji"];

const EMOJI_INTENTS: Record<string, ReactionIntent> = {
  "👍": "approve",
  "👏": "approve",
  "❤": "approve",
  "❤️": "approve",
  "🔥": "approve",
  "🥰": "approve",
  "😍": "approve",
  "👎": "dissatisfied",
  "😡": "dissatisfied",
  "🤔": "unclear",
  "🤨": "unclear",
  "🤬": "abort",
};

const ACK_EMOJIS: Record<ReactionIntent, AckEmoji> = {
  approve: "🫡",
  dissatisfied: "👌",
  unclear: "👌",
  abort: "👻",
};

const FEEDBACK_PROMPTS: Record<"dissatisfied" | "unclear", string> = {
  dissatisfied:
    "[Telegram feedback] The user reacted 👎 to the current run output. Treat it as a signal that the last steps were wrong or unhelpful: reconsider the approach, correct course, and avoid repeating the same mistake.",
  unclear:
    "[Telegram feedback] The user reacted 🤔 to the current run output. The last explanation or step was unclear: re-explain it more simply before continuing.",
};

const DEBOUNCE_MS = 10_000;
const DEBOUNCE_MAX = 1000;
const recentReactions = new Map<string, number>();

function isDuplicate(chatId: number, messageId: number, emoji: string): boolean {
  const key = `${chatId}:${messageId}:${emoji}`;
  const now = Date.now();
  const last = recentReactions.get(key);
  if (last !== undefined && now - last < DEBOUNCE_MS) return true;
  recentReactions.set(key, now);
  if (recentReactions.size > DEBOUNCE_MAX) {
    for (const [entryKey, at] of recentReactions) {
      if (now - at >= DEBOUNCE_MS) recentReactions.delete(entryKey);
    }
  }
  return false;
}

async function resolveDirectory(sessionId: string): Promise<string | null> {
  const binding = await findTelegramTopicBindingBySessionId(sessionId).catch(() => null);
  if (binding?.directory) return binding.directory;
  const current = getCurrentSession();
  return current?.id === sessionId ? current.directory ?? null : null;
}

async function ackReaction(ctx: Context, chatId: number, messageId: number, emoji: AckEmoji): Promise<void> {
  await ctx.api
    .setMessageReaction(chatId, messageId, [{ type: "emoji", emoji }])
    .catch((error) => logger.debug("[Reactions] Failed to ack reaction:", error));
}

async function injectFeedbackPrompt(sessionId: string, directory: string, intent: "dissatisfied" | "unclear"): Promise<void> {
  const text = FEEDBACK_PROMPTS[intent];
  if (assistantRunState.hasActiveRun(sessionId)) {
    const queued = promptQueue.add(text, sessionId);
    if (queued) {
      logger.info(`[Reactions] Feedback queued for active run: session=${sessionId}, intent=${intent}`);
      return;
    }
    logger.warn(`[Reactions] Prompt queue full, sending feedback directly: session=${sessionId}, intent=${intent}`);
  }
  const { error } = await opencodeClient.session.promptAsync({ sessionID: sessionId, directory, parts: [{ type: "text", text }] });
  if (error) {
    logger.warn(`[Reactions] Failed to inject feedback prompt: session=${sessionId}, intent=${intent}`, error);
    return;
  }
  logger.info(`[Reactions] Feedback injected: session=${sessionId}, intent=${intent}`);
}

async function abortRun(sessionId: string, directory: string): Promise<void> {
  const { error } = await opencodeClient.session.abort({ sessionID: sessionId, directory });
  if (error) {
    logger.warn(`[Reactions] Failed to abort via reaction: session=${sessionId}`, error);
    return;
  }
  logger.info(`[Reactions] Run aborted via reaction: session=${sessionId}`);
}

export async function handleReactionFeedback(ctx: Context): Promise<void> {
  const update = ctx.messageReaction;
  if (!update) return;

  const chatId = update.chat.id;
  const messageId = update.message_id;
  const emojiOf = (reaction: ReactionType): string | null => (reaction.type === "emoji" ? reaction.emoji : null);
  const previous = new Set((update.old_reaction ?? []).map(emojiOf).filter((emoji): emoji is string => Boolean(emoji)));
  const added = (update.new_reaction ?? [])
    .map(emojiOf)
    .filter((emoji): emoji is string => typeof emoji === "string" && emoji.length > 0 && !previous.has(emoji));
  if (added.length === 0) return;

  const entry = lookupBotMessage(chatId, messageId);
  if (!entry) return;

  for (const emoji of added) {
    const intent = EMOJI_INTENTS[emoji];
    if (!intent) continue;
    if (isDuplicate(chatId, messageId, emoji)) continue;

    logger.info(`[Reactions] ${emoji} (${intent}) on bot message: chat=${chatId}, message=${messageId}, session=${entry.sessionId}`);

    if (intent === "approve") {
      await ackReaction(ctx, chatId, messageId, ACK_EMOJIS[intent]);
      continue;
    }

    const directory = await resolveDirectory(entry.sessionId);
    if (!directory) {
      logger.warn(`[Reactions] No directory resolved for session=${entry.sessionId}, ignoring ${intent} reaction`);
      continue;
    }

    if (intent === "abort") {
      await abortRun(entry.sessionId, directory);
      await ackReaction(ctx, chatId, messageId, ACK_EMOJIS[intent]);
      continue;
    }

    await injectFeedbackPrompt(entry.sessionId, directory, intent);
    await ackReaction(ctx, chatId, messageId, ACK_EMOJIS[intent]);
  }
}
