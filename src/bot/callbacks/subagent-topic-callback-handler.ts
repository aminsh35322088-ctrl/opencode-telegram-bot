import type { Context } from "grammy";
import { getCurrentSession } from "../../app/services/session-service.js";
import { opencodeClient } from "../../opencode/client.js";
import {
  SUBAGENT_VIEW_CALLBACK_PREFIX,
  subagentTopicInspector,
} from "../services/subagent-topic-inspector.js";
import { logger } from "../../utils/logger.js";

export interface SubagentTopicCallbackDeps {
  ensureEventSubscription: (directory: string) => Promise<void>;
}

function replaceClickedButtonWithLink(
  ctx: Context,
  callbackData: string,
  url: string,
): Promise<unknown> {
  const markup = ctx.callbackQuery?.message?.reply_markup;
  if (!markup) return Promise.resolve();

  const inline_keyboard = markup.inline_keyboard.map((row) =>
    row.map((button) => {
      if ("callback_data" in button && button.callback_data === callbackData) {
        return { text: "↗️ Open Sub-agent", url };
      }
      return button;
    }),
  );
  return ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard } });
}

export async function handleSubagentTopicCallback(
  ctx: Context,
  deps: SubagentTopicCallbackDeps,
): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith(SUBAGENT_VIEW_CALLBACK_PREFIX)) return false;

  const childSessionId = data.slice(SUBAGENT_VIEW_CALLBACK_PREFIX.length).trim();
  const parent = getCurrentSession();
  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id;
  if (!childSessionId || !parent || typeof chatId !== "number") {
    await ctx
      .answerCallbackQuery({ text: "Sub-agent session is no longer available.", show_alert: true })
      .catch(() => {});
    return true;
  }

  try {
    const { data: child, error } = await opencodeClient.session.get({
      sessionID: childSessionId,
      directory: parent.directory,
    });
    if (error || !child) throw error ?? new Error("Sub-agent session not found");
    if (child.parentID !== parent.id) {
      throw new Error(
        `Refusing inspector open for child outside current parent: parent=${parent.id} child=${childSessionId}`,
      );
    }

    await deps.ensureEventSubscription(parent.directory);
    const opened = await subagentTopicInspector.open(ctx.api, {
      chatId,
      botId: ctx.me.id,
      parentSessionId: parent.id,
      sessionId: childSessionId,
      directory: parent.directory,
      title: child.title || `Sub-agent ${childSessionId.slice(0, 8)}`,
    });

    await replaceClickedButtonWithLink(ctx, data, opened.deepLink).catch((error) => {
      logger.debug("[SubagentTopics] Could not upgrade View button to direct Topic link:", error);
    });

    await ctx
      .answerCallbackQuery({ text: "Inspector ready — tap ↗️ Open Sub-agent." })
      .catch(() => {});
    logger.info(
      `[SubagentTopics] Inspector opened from parent: parent=${parent.id} child=${childSessionId} thread=${opened.binding.threadId}`,
    );
  } catch (error) {
    logger.error("[SubagentTopics] Failed to open inspector:", error);
    await ctx
      .answerCallbackQuery({ text: "Could not open the Sub-agent Topic.", show_alert: true })
      .catch(() => {});
  }
  return true;
}
