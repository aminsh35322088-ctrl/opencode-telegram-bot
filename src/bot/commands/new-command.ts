import type { Bot } from "grammy";
import { CommandContext, Context } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { setCurrentSession, getCurrentSessionDirectory } from "../../app/services/session-service.js";
import type { SessionInfo } from "../../app/types/session.js";
import { ingestSessionInfoForCache } from "../../app/services/session-cache-service.js";
import { clearAllInteractionState } from "../../app/managers/interaction-manager.js";
import { keyboardManager } from "../keyboards/keyboard-manager.js";
import { getStoredAgent, resolveProjectAgent } from "../../app/services/agent-selection-service.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { formatVariantForButton } from "../../app/services/variant-selection-service.js";
import { createMainKeyboard } from "../keyboards/main-reply-keyboard.js";
import { isForegroundBusy } from "../../app/services/run-control-service.js";
import { replyBusyBlocked } from "../messages/busy-blocked-renderer.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { attachToSession } from "../../app/services/attach-service.js";
import { clearPausedSession } from "../../app/managers/paused-session-manager.js";
import {
  openSessionInTelegramTopic,
  sendToTelegramTopic,
} from "../../app/services/telegram-topic-session-service.js";
import {
  createTopicAwareBot,
  setActiveTelegramTopic,
} from "../services/telegram-topic-runtime.js";

export interface NewCommandDeps {
  bot: Bot<Context>;
  ensureEventSubscription: (directory: string) => Promise<void>;
}

// A Telegram update can be retried while the first handler is still running.
// Keep /new single-flight so two concurrent deliveries cannot create two
// OpenCode sessions for the same deployment.
let newSessionCreation: Promise<void> | null = null;

export async function newCommand(ctx: CommandContext<Context>, deps: NewCommandDeps): Promise<void> {
  if (newSessionCreation) {
    logger.warn("[Bot] Ignored concurrent /new request while session creation is already in progress");
    return;
  }

  newSessionCreation = createNewSession(ctx, deps).finally(() => {
    newSessionCreation = null;
  });

  await newSessionCreation;
}

async function createNewSession(ctx: CommandContext<Context>, deps: NewCommandDeps): Promise<void> {
  try {
    clearPausedSession();
    keyboardManager.setPaused(false);

    if (isForegroundBusy()) {
      await replyBusyBlocked(ctx);
      return;
    }

    const directory = getCurrentSessionDirectory();
    logger.debug("[Bot] Creating new session for directory:", directory);

    const { data: session, error } = await opencodeClient.session.create({ directory });

    if (error || !session) {
      throw error || new Error("No data received from server");
    }

    logger.info(
      `[Bot] Created new session via /new command: id=${session.id}, title="${session.title}", directory=${directory}`,
    );

    const sessionInfo: SessionInfo = {
      id: session.id,
      title: session.title,
      directory,
    };

    const binding = await openSessionInTelegramTopic(deps.bot.api, ctx.chat.id, sessionInfo);
    setActiveTelegramTopic({ chatId: ctx.chat.id, threadId: binding.threadId });

    setCurrentSession(sessionInfo);
    clearAllInteractionState("session_created");
    await ingestSessionInfoForCache(session);

    await attachToSession({
      bot: createTopicAwareBot(deps.bot),
      chatId: ctx.chat.id,
      session: sessionInfo,
      ensureEventSubscription: deps.ensureEventSubscription,
    });

    const currentAgent = await resolveProjectAgent(getStoredAgent());
    const currentModel = getStoredModel();
    keyboardManager.updateAgent(currentAgent);
    const contextInfo = keyboardManager.getContextInfo();
    const variantName = formatVariantForButton(currentModel.variant || "default");
    const keyboard = createMainKeyboard(currentAgent, currentModel, contextInfo ?? undefined, variantName);

    const topicMessage = t("new.created", { title: session.title });
    await sendToTelegramTopic(
      deps.bot.api,
      binding,
      keyboard ? `${topicMessage}\n\nUse this Topic for the conversation.` : topicMessage,
    );

    if (keyboard) {
      await deps.bot.api.sendMessage(ctx.chat.id, "", {
        message_thread_id: binding.threadId,
        reply_markup: keyboard,
      });
    }

    logger.info(
      `[TelegramTopics] New Chat opened in topic: session=${session.id}, chat=${ctx.chat.id}, thread=${binding.threadId}`,
    );
  } catch (error) {
    logger.error("[Bot] Error creating session:", error);
    await ctx.reply(t("new.create_error"));
  }
}
