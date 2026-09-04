import type { Bot, Context } from "grammy";
import { CommandContext } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { setCurrentSession } from "../../app/services/session-service.js";
import type { SessionInfo } from "../../app/types/session.js";
import { ingestSessionInfoForCache } from "../../app/services/session-cache-service.js";
import { clearAllInteractionState } from "../../app/managers/interaction-manager.js";
import { keyboardManager } from "../keyboards/keyboard-manager.js";
import { getStoredAgent, resolveProjectAgent } from "../../app/services/agent-selection-service.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { getTopicDefaults } from "../../app/stores/settings-store.js";
import { createTopicKeyboard } from "../keyboards/main-reply-keyboard.js";
import { isForegroundBusy } from "../../app/services/run-control-service.js";
import { replyBusyBlocked } from "../messages/busy-blocked-renderer.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { attachToSession } from "../../app/services/attach-service.js";
import { clearPausedSession } from "../../app/managers/paused-session-manager.js";
import { openSessionInTelegramTopic } from "../../app/services/telegram-topic-session-service.js";
import { createTelegramTopicWorkspace, deleteTelegramTopicWorkspace } from "../../app/services/telegram-topic-workspace-service.js";
import { createTopicAwareBot, setActiveTelegramTopic } from "../services/telegram-topic-runtime.js";
import { initializeTopicRuntimeState, ensureTopicRuntimeStateSync } from "../../app/stores/topic-runtime-state-store.js";
import { runInTopicRuntimeContext } from "../../app/services/topic-runtime-context.js";

export interface NewCommandDeps {
  bot: Bot<Context>;
  ensureEventSubscription: (directory: string) => Promise<void>;
}

export async function newCommand(ctx: CommandContext<Context>, deps: NewCommandDeps): Promise<void> {
  await createNewSession(ctx, deps);
}

async function createNewSession(ctx: CommandContext<Context>, deps: NewCommandDeps): Promise<void> {
  let directory: string | null = null;
  let sessionId: string | null = null;
  let topicBindingCreated = false;

  try {
    clearPausedSession();
    if (isForegroundBusy()) {
      await replyBusyBlocked(ctx);
      return;
    }

    directory = await createTelegramTopicWorkspace(ctx.chat.id);
    const { data: session, error } = await opencodeClient.session.create({ directory });
    if (error || !session) throw error || new Error("No session received from OpenCode");

    sessionId = session.id;
    const sessionInfo: SessionInfo = { id: session.id, title: session.title, directory };

    const defaults = getTopicDefaults();
    const initialAgent = defaults.agent ?? await resolveProjectAgent(getStoredAgent());
    const initialModel = defaults.model ?? getStoredModel();
    const initialCompact = defaults.compactOutputMode;
    const binding = await openSessionInTelegramTopic(deps.bot.api, ctx.chat.id, sessionInfo);
    topicBindingCreated = true;

    await initializeTopicRuntimeState(binding.chatId, binding.threadId, {
      ...defaults,
      session: sessionInfo,
      agent: initialAgent,
      model: initialModel,
    });
    ensureTopicRuntimeStateSync(binding.chatId, binding.threadId, {
      ...defaults,
      session: sessionInfo,
      agent: initialAgent,
      model: initialModel,
      compactOutputMode: initialCompact,
    });

    setActiveTelegramTopic({ chatId: ctx.chat.id, threadId: binding.threadId });

    await runInTopicRuntimeContext(
      { chatId: ctx.chat.id, threadId: binding.threadId, sessionId: session.id },
      async () => {
        setCurrentSession(sessionInfo);
        keyboardManager.bindTopic(deps.bot.api, ctx.chat.id, binding.threadId, session.id);
        keyboardManager.updateAgent(initialAgent, session.id);
        keyboardManager.updateModel(initialModel, session.id);
        clearAllInteractionState("session_created");

        await ingestSessionInfoForCache(session);
        await attachToSession({
          bot: createTopicAwareBot(deps.bot, { chatId: ctx.chat.id, threadId: binding.threadId }),
          chatId: ctx.chat.id,
          session: sessionInfo,
          ensureEventSubscription: deps.ensureEventSubscription,
        });

        const keyboard = createTopicKeyboard({ paused: false });
        await deps.bot.api.sendMessage(
          ctx.chat.id,
          `${t("new.created", { title: session.title })}\n\nUse this Topic for the conversation.`,
          {
            message_thread_id: binding.threadId,
            reply_markup: keyboard,
          },
        );

        logger.info(
          `[TelegramTopics] Topic keyboard installed: session=${session.id}, thread=${binding.threadId}, buttons=topic-only`,
        );
      },
    );

    logger.info(
      `[TelegramTopics] New Chat opened: session=${session.id}, chat=${ctx.chat.id}, thread=${binding.threadId}, directory=${directory}`,
    );
  } catch (error) {
    logger.error("[Bot] Error creating session:", error);
    if (directory && !topicBindingCreated) {
      if (sessionId) {
        try {
          await opencodeClient.session.delete({ sessionID: sessionId, directory });
        } catch (cleanupError) {
          logger.warn(`[TelegramTopics] Failed to clean orphan session ${sessionId}`, cleanupError);
        }
      }
      try {
        await deleteTelegramTopicWorkspace(directory);
      } catch (cleanupError) {
        logger.warn(`[TelegramTopics] Failed to clean workspace ${directory}`, cleanupError);
      }
    }
    await ctx.reply(t("new.create_error"));
  }
}
