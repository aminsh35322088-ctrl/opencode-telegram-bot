import type { Bot, Context, NextFunction } from "grammy";
import { config } from "../../config.js";
import { getCurrentProject } from "../../app/stores/settings-store.js";
import { getCurrentSession, setCurrentSession } from "../../app/services/session-service.js";
import { opencodeClient } from "../../opencode/client.js";
import { attachToSession } from "../../app/services/attach-service.js";
import { attachManager } from "../../app/managers/attach-manager.js";
import { clearAllInteractionState } from "../../app/managers/interaction-manager.js";
import { openSessionInTelegramTopic, sendToTelegramTopic } from "../../app/services/telegram-topic-session-service.js";
import { findTelegramTopicBindingByThread } from "../../app/services/telegram-topic-store.js";
import { keyboardManager } from "../keyboards/keyboard-manager.js";
import { enrichTelegramReplyContext } from "../../app/services/telegram-reply-context-service.js";
import { stashRawReplyKeyboardText } from "../interaction-classifier.js";
import { createTopicAwareBot, getTelegramTopicRuntimeDependencies, setActiveTelegramTopic } from "../services/telegram-topic-runtime.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { runInTopicRuntimeContext } from "../../app/services/topic-runtime-context.js";

const SESSION_CONTINUE_CALLBACK_PREFIX = "session:continue:";

function getTopicMessage(ctx: Context): { chatId: number; threadId: number } | null {
  const message = ctx.message as { chat?: { id?: number }; message_thread_id?: number; is_topic_message?: boolean } | undefined;
  const chatId = message?.chat?.id;
  const threadId = message?.message_thread_id;
  if (typeof chatId !== "number" || typeof threadId !== "number" || threadId === 1 || !message?.is_topic_message) return null;
  return { chatId, threadId };
}

function bindingTitle(binding: Awaited<ReturnType<typeof findTelegramTopicBindingByThread>>): string {
  return binding?.title?.trim() || `Session ${binding?.sessionId.slice(0, 8) ?? "unknown"}`;
}

async function attachBoundTopicSession(ctx: Context, binding: Awaited<ReturnType<typeof findTelegramTopicBindingByThread>>): Promise<boolean> {
  if (!binding || !ctx.chat) return false;
  const title = bindingTitle(binding);
  const currentSession = getCurrentSession();
  if (currentSession?.id !== binding.sessionId || currentSession.directory !== binding.directory) {
    setCurrentSession({ id: binding.sessionId, title, directory: binding.directory });
    clearAllInteractionState("telegram_topic_session_switch");
  }
  keyboardManager.bindTopic(ctx.api, binding.chatId, binding.threadId, binding.sessionId);
  if (attachManager.isAttachedSession(binding.sessionId, binding.directory)) return true;
  try {
    const topicBot = createTopicAwareBot(
      { api: ctx.api } as unknown as Bot<Context>,
      { chatId: binding.chatId, threadId: binding.threadId },
    );
    const runtime = getTelegramTopicRuntimeDependencies();
    if (!runtime) throw new Error("Telegram topic runtime dependencies are not initialized");
    await attachToSession({
      bot: topicBot,
      chatId: ctx.chat.id,
      session: { id: binding.sessionId, title, directory: binding.directory },
      ensureEventSubscription: runtime.ensureEventSubscription,
    });
    return true;
  } catch (error) {
    logger.error(`[TelegramTopics] Failed to attach bound topic session: session=${binding.sessionId}, thread=${binding.threadId}`, error);
    return false;
  }
}

async function handleSessionContinueCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  const chatId = ctx.chat?.id;
  if (!data?.startsWith(SESSION_CONTINUE_CALLBACK_PREFIX) || typeof chatId !== "number") return false;
  const sessionId = data.slice(SESSION_CONTINUE_CALLBACK_PREFIX.length).trim();
  if (!sessionId) {
    await ctx.answerCallbackQuery({ text: t("callback.processing_error"), show_alert: true }).catch(() => {});
    return true;
  }
  try {
    const currentProject = getCurrentProject();
    if (!currentProject) {
      await ctx.answerCallbackQuery({ text: t("sessions.select_project_first"), show_alert: true }).catch(() => {});
      return true;
    }
    const { data: session, error } = await opencodeClient.session.get({ sessionID: sessionId, directory: currentProject.worktree });
    if (error || !session) throw error ?? new Error("Failed to load the selected session");
    const sessionInfo = { id: session.id, title: session.title, directory: currentProject.worktree };
    const binding = await openSessionInTelegramTopic(ctx.api, chatId, sessionInfo);
    setActiveTelegramTopic({ chatId, threadId: binding.threadId });
    await runInTopicRuntimeContext({ chatId, threadId: binding.threadId, sessionId: session.id, directory: sessionInfo.directory }, async () => {
      setCurrentSession(sessionInfo);
      keyboardManager.bindTopic(ctx.api, chatId, binding.threadId, session.id);
      clearAllInteractionState("telegram_topic_session_opened");
      const topicBot = createTopicAwareBot(
        { api: ctx.api } as unknown as Bot<Context>,
        { chatId, threadId: binding.threadId },
      );
      const runtime = getTelegramTopicRuntimeDependencies();
      if (!runtime) throw new Error("Telegram topic runtime dependencies are not initialized");
      await attachToSession({ bot: topicBot, chatId, session: sessionInfo, ensureEventSubscription: runtime.ensureEventSubscription });
      await sendToTelegramTopic(ctx.api, binding, t("sessions.selected", { title: session.title }));
    });
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.deleteMessage().catch(() => {});
    logger.info(`[TelegramTopics] Opened History session in topic: session=${session.id}, chat=${chatId}, thread=${binding.threadId}`);
  } catch (error) {
    logger.error("[TelegramTopics] Failed to continue session in topic:", error);
    await ctx.answerCallbackQuery({ text: "Could not open this session as a Topic. Enable Threaded Mode for the bot in BotFather.", show_alert: true }).catch(() => {});
  }
  return true;
}

export async function authMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const userId = ctx.from?.id;
  const allowedUserId = config.telegram.allowedUserId;
  logger.debug(`[Auth] Checking access: userId=${userId}, allowedUserId=${allowedUserId}, hasCallbackQuery=${!!ctx.callbackQuery}, hasMessage=${!!ctx.message}`);
  if (userId !== allowedUserId) {
    logger.warn(`Unauthorized access attempt from user ID: ${userId}`);
    return;
  }

  // Telegram KeyboardButton presses arrive as ordinary text messages. Preserve
  // the authentic text for every update before any downstream middleware can
  // enrich or mutate ctx.message.text. The classifier uses this immutable
  // snapshot for all Reply Keyboard controls, not just Topic Settings.
  const rawMessageText = typeof ctx.message?.text === "string" ? ctx.message.text : undefined;
  if (rawMessageText !== undefined) {
    stashRawReplyKeyboardText(ctx, rawMessageText);
  }

  if (await handleSessionContinueCallback(ctx)) return;

  const topic = getTopicMessage(ctx);
  if (topic) {
    setActiveTelegramTopic(topic);
    const binding = await findTelegramTopicBindingByThread(topic.chatId, topic.threadId);
    if (binding) {
      // Bind/attach must run inside this Topic's runtime context: otherwise
      // keyboard/session state lands on the shared main instance and can
      // clobber or mis-read the state of other concurrently streaming Topics.
      await runInTopicRuntimeContext({ chatId: topic.chatId, threadId: topic.threadId, sessionId: binding.sessionId, directory: binding.directory }, async () => {
        const attached = await attachBoundTopicSession(ctx, binding);
        if (!attached) {
          await sendToTelegramTopic(ctx.api, binding, "❌ Could not restore this Topic session. Please reopen it from History.").catch(() => {});
          return;
        }
        await enrichTelegramReplyContext(ctx, binding.directory);
        await next();
      });
      return;
    }
    await runInTopicRuntimeContext({ chatId: topic.chatId, threadId: topic.threadId }, () => next());
    return;
  }

  await next();
}
