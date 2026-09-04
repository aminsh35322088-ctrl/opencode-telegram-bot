import type { Bot, Context, NextFunction } from "grammy";
import { config } from "../../config.js";
import { getCurrentProject } from "../../app/stores/settings-store.js";
import { getCurrentSession, setCurrentSession } from "../../app/services/session-service.js";
import { opencodeClient } from "../../opencode/client.js";
import { attachToSession } from "../../app/services/attach-service.js";
import { attachManager } from "../../app/managers/attach-manager.js";
import { clearAllInteractionState, interactionManager } from "../../app/managers/interaction-manager.js";
import { questionManager } from "../../app/managers/question-manager.js";
import { isProviderWizardActive } from "../commands/providers-command.js";
import { isIntegrationWizardActive } from "../commands/integrations-command.js";
import { getImageMode } from "../../app/services/image-mode-service.js";
import { formatModelForButton } from "../../app/types/model.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { isReplyKeyboardButtonText } from "../message-patterns.js";
import { openSessionInTelegramTopic, sendToTelegramTopic } from "../../app/services/telegram-topic-session-service.js";
import { findTelegramTopicBindingByThread } from "../../app/services/telegram-topic-store.js";
import {
  createTopicAwareBot,
  getTelegramTopicRuntimeDependencies,
  setActiveTelegramTopic,
} from "../services/telegram-topic-runtime.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";

const SESSION_CONTINUE_CALLBACK_PREFIX = "session:continue:";
const MAIN_CHAT_ONLY_HELP =
  "💬 Chatting with the AI is available inside Topics only.\n\nUse 💬 New Chat or open a session from 🕘 History.";

function getTopicMessage(ctx: Context): { chatId: number; threadId: number } | null {
  const message = ctx.message as
    | { chat?: { id?: number }; message_thread_id?: number; is_topic_message?: boolean }
    | undefined;
  const chatId = message?.chat?.id;
  const threadId = message?.message_thread_id;

  if (
    typeof chatId !== "number" ||
    typeof threadId !== "number" ||
    !message?.is_topic_message
  ) {
    return null;
  }

  return { chatId, threadId };
}

function getCurrentModelButtonText(): string {
  const model = getStoredModel();
  if (!model.providerID || !model.modelID) return "🧠 Model";
  return formatModelForButton(model.providerID, model.modelID, model.name);
}

function isMainControlText(text: string): boolean {
  return isReplyKeyboardButtonText(text, new Set([getCurrentModelButtonText()]));
}

function hasConfigurationInteraction(): boolean {
  return (
    interactionManager.getSnapshot() !== null ||
    questionManager.isActive() ||
    isProviderWizardActive() ||
    isIntegrationWizardActive() ||
    getImageMode() !== null
  );
}

async function attachBoundTopicSession(
  ctx: Context,
  binding: Awaited<ReturnType<typeof findTelegramTopicBindingByThread>>,
): Promise<boolean> {
  if (!binding || !ctx.chat) return false;

  const currentSession = getCurrentSession();
  if (currentSession?.id !== binding.sessionId || currentSession.directory !== binding.directory) {
    setCurrentSession({
      id: binding.sessionId,
      title: binding.title,
      directory: binding.directory,
    });
    clearAllInteractionState("telegram_topic_session_switch");
  }

  if (attachManager.isAttachedSession(binding.sessionId, binding.directory)) {
    return true;
  }

  try {
    const topicBot = createTopicAwareBot({ api: ctx.api } as unknown as Bot<Context>);
    const runtime = getTelegramTopicRuntimeDependencies();
    if (!runtime) {
      throw new Error("Telegram topic runtime dependencies are not initialized");
    }

    await attachToSession({
      bot: topicBot,
      chatId: ctx.chat.id,
      session: {
        id: binding.sessionId,
        title: binding.title,
        directory: binding.directory,
      },
      ensureEventSubscription: runtime.ensureEventSubscription,
    });
    return true;
  } catch (error) {
    logger.error(
      `[TelegramTopics] Failed to attach bound topic session: session=${binding.sessionId}, thread=${binding.threadId}`,
      error,
    );
    return false;
  }
}

async function handleSessionContinueCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  const chatId = ctx.chat?.id;
  if (!data?.startsWith(SESSION_CONTINUE_CALLBACK_PREFIX) || typeof chatId !== "number") {
    return false;
  }

  const sessionId = data.slice(SESSION_CONTINUE_CALLBACK_PREFIX.length).trim();
  if (!sessionId) {
    await ctx.answerCallbackQuery({ text: t("callback.processing_error"), show_alert: true }).catch(() => {});
    return true;
  }

  try {
    const currentProject = getCurrentProject();
    const { data: session, error } = await opencodeClient.session.get({
      sessionID: sessionId,
      directory: currentProject.worktree,
    });

    if (error || !session) {
      throw error ?? new Error("Failed to load the selected session");
    }

    const sessionInfo = {
      id: session.id,
      title: session.title,
      directory: currentProject.worktree,
    };
    const binding = await openSessionInTelegramTopic(ctx.api, chatId, sessionInfo);

    setActiveTelegramTopic({ chatId, threadId: binding.threadId });
    setCurrentSession(sessionInfo);
    clearAllInteractionState("telegram_topic_session_opened");

    const topicBot = createTopicAwareBot({ api: ctx.api } as unknown as Bot<Context>);
    const runtime = getTelegramTopicRuntimeDependencies();
    if (!runtime) {
      throw new Error("Telegram topic runtime dependencies are not initialized");
    }

    await attachToSession({
      bot: topicBot,
      chatId,
      session: sessionInfo,
      ensureEventSubscription: runtime.ensureEventSubscription,
    });

    await sendToTelegramTopic(
      ctx.api,
      binding,
      t("sessions.selected", { title: session.title }),
    );

    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.deleteMessage().catch(() => {});
    logger.info(
      `[TelegramTopics] Opened History session in topic: session=${session.id}, chat=${chatId}, thread=${binding.threadId}`,
    );
  } catch (error) {
    logger.error("[TelegramTopics] Failed to continue session in topic:", error);
    await ctx.answerCallbackQuery({
      text: "Could not open this session as a Topic. Enable Threaded Mode for the bot in BotFather.",
      show_alert: true,
    }).catch(() => {});
  }

  return true;
}

export async function authMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const userId = ctx.from?.id;
  const allowedUserId = config.telegram.allowedUserId;

  logger.debug(
    `[Auth] Checking access: userId=${userId}, allowedUserId=${allowedUserId}, hasCallbackQuery=${!!ctx.callbackQuery}, hasMessage=${!!ctx.message}`,
  );

  if (userId !== allowedUserId) {
    logger.warn(`Unauthorized access attempt from user ID: ${userId}`);
    return;
  }

  if (await handleSessionContinueCallback(ctx)) {
    return;
  }

  const topic = getTopicMessage(ctx);
  if (topic) {
    setActiveTelegramTopic(topic);
    const binding = await findTelegramTopicBindingByThread(topic.chatId, topic.threadId);

    if (binding) {
      const attached = await attachBoundTopicSession(ctx, binding);
      if (!attached) {
        await sendToTelegramTopic(ctx.api, binding, "❌ Could not restore this Topic session. Please reopen it from History.").catch(() => {});
        return;
      }
      await next();
      return;
    }

    const text = ctx.message && "text" in ctx.message ? String(ctx.message.text ?? "").trim() : "";
    if (!text.startsWith("/")) {
      await ctx.api.sendMessage(topic.chatId, MAIN_CHAT_ONLY_HELP, {
        message_thread_id: topic.threadId,
      }).catch(() => {});
      return;
    }

    await next();
    return;
  }

  const message = ctx.message;
  if (message) {
    const text = "text" in message && typeof message.text === "string" ? message.text.trim() : "";
    const allowedMainInput =
      text.startsWith("/") ||
      isMainControlText(text) ||
      hasConfigurationInteraction();

    if (!allowedMainInput) {
      await ctx.reply(MAIN_CHAT_ONLY_HELP).catch(() => {});
      return;
    }
  }

  await next();
}
