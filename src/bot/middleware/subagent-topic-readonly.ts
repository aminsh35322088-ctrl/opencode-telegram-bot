import type { Context, NextFunction } from "grammy";
import { findSubagentTopicByThread } from "../../app/services/subagent-topic-store.js";
import {
  SUBAGENT_CLOSE_BUTTON,
  subagentTopicInspector,
} from "../services/subagent-topic-inspector.js";
import { logger } from "../../utils/logger.js";

function getThread(ctx: Context): { chatId: number; threadId: number } | null {
  const message = ctx.message as
    | { chat?: { id?: number }; message_thread_id?: number; is_topic_message?: boolean }
    | undefined;
  if (
    typeof message?.chat?.id !== "number" ||
    typeof message.message_thread_id !== "number" ||
    message.message_thread_id <= 1
  ) {
    return null;
  }
  return { chatId: message.chat.id, threadId: message.message_thread_id };
}

export async function subagentTopicReadonlyMiddleware(
  ctx: Context,
  next: NextFunction,
): Promise<void> {
  const thread = getThread(ctx);
  if (!thread) {
    await next();
    return;
  }

  const binding = await findSubagentTopicByThread(thread.chatId, thread.threadId);
  if (!binding) {
    await next();
    return;
  }

  // Bot-originated/service messages are not user input and need no response.
  if (!ctx.from || ctx.from.id === ctx.me.id) return;

  const text = typeof ctx.message?.text === "string" ? ctx.message.text.trim() : "";
  if (text === SUBAGENT_CLOSE_BUTTON) {
    await subagentTopicInspector.close(ctx.api, binding, "user");
    logger.info(
      `[SubagentTopics] User closed inspector: parent=${binding.parentSessionId} child=${binding.sessionId} thread=${binding.threadId}`,
    );
    return;
  }

  await ctx.reply(
    "🔒 This Sub-agent Topic is read-only. Control the run from its parent chat, or tap ✖️ Close.",
    {
      reply_markup: { keyboard: [[{ text: SUBAGENT_CLOSE_BUTTON }]], resize_keyboard: true },
    },
  );
}
