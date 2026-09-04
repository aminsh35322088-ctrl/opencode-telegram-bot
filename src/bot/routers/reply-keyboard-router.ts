import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import { assistantRunState } from "../../app/managers/assistant-run-state-manager.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { formatModelForButton } from "../../app/types/model.js";
import { getCompactOutputMode, setCompactOutputMode } from "../../app/stores/settings-store.js";
import { pauseCurrentChat, resumePausedChat } from "../commands/pause-command.js";
import { abortCurrentOperation } from "../commands/abort-command.js";
import { sessionsCommand } from "../commands/sessions-command.js";
import { newCommand } from "../commands/new-command.js";
import { settingsCommand } from "../commands/settings-command.js";
import { showModelCenterMenu } from "../menus/model-center-menu.js";
import { showAgentSelectionMenu } from "../menus/agent-selection-menu.js";
import { handleContextButtonPress } from "../menus/context-control-menu.js";
import { showVariantSelectionMenu } from "../menus/variant-selection-menu.js";
import { MAIN_BUTTONS, TOPIC_BUTTONS } from "../keyboards/main-reply-keyboard.js";
import { keyboardManager } from "../keyboards/keyboard-manager.js";
import { findQueuedPromptByButtonLabel } from "../keyboards/queued-prompt-button.js";
import { promptQueue } from "../../app/managers/prompt-queue-manager.js";
import { isProviderWizardActive, clearProviderWizard, providersCommand } from "../commands/providers-command.js";
import { isIntegrationWizardActive, clearIntegrationWizard, integrationsCommand } from "../commands/integrations-command.js";
import { clearImageMode } from "../../app/services/image-mode-service.js";
import { isReplyKeyboardButtonText, AGENT_MODE_BUTTON_TEXT_PATTERN, CONTEXT_BUTTON_TEXT_PATTERN, QUEUED_PROMPT_BUTTON_TEXT_PATTERN, VARIANT_BUTTON_TEXT_PATTERN } from "../message-patterns.js";
import { getTopicRuntimeContext } from "../../app/services/topic-runtime-context.js";
import { showTelegramTopicDeleteConfirmation } from "../services/telegram-topic-delete-handler.js";

function normalized(text: string): string {
  return text.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\uFE0F/g, "").replace(/\s+/g, " ").trim();
}

function currentModelButton(): string {
  const model = getStoredModel();
  return model.providerID && model.modelID ? formatModelForButton(model.providerID, model.modelID, model.name) : "🧠 Model";
}

/** Forum Topic updates are identified from Telegram itself, not from our persisted binding. */
function isTopicMessage(ctx: Context): boolean {
  const message = ctx.message as { message_thread_id?: number; is_topic_message?: boolean } | undefined;
  if (typeof message?.message_thread_id === "number") {
    // Telegram's General topic is the special thread id 1. User-created/forum
    // topics have their own thread id and must never fall through to prompts.
    return message.message_thread_id !== 1 && message.is_topic_message !== false;
  }
  const runtime = getTopicRuntimeContext();
  return Boolean(runtime?.sessionId && runtime.threadId !== undefined && runtime.threadId !== 1);
}

function isExact(text: string, candidate: string): boolean {
  return normalized(text) === normalized(candidate);
}

async function menuAllowed(ctx: Context): Promise<boolean> {
  if (assistantRunState.hasActiveRuns()) return false;
  const interaction = interactionManager.getSnapshot();
  if (!interaction) return true;
  if (interaction.kind === "inline") return true;
  await ctx.reply(t("interaction.blocked.finish_current"));
  return false;
}

export function registerReplyKeyboardRouter(bot: Bot<Context>, deps: { bot: Bot<Context>; ensureEventSubscription: (directory: string) => Promise<void> }): void {
  bot.on("message:text", async (ctx, next) => {
    const raw = ctx.message.text;
    const text = normalized(raw);
    if (!text) return next();

    const topic = isTopicMessage(ctx);
    const modelButton = normalized(currentModelButton());
    const compactOn = normalized(MAIN_BUTTONS.compact(true));
    const compactOff = normalized(MAIN_BUTTONS.compact(false));
    const topicButtonTexts = new Set([
      normalized(TOPIC_BUTTONS.abort),
      normalized(TOPIC_BUTTONS.pause),
      normalized(TOPIC_BUTTONS.resume),
      normalized(TOPIC_BUTTONS.imageAi),
      compactOn,
      compactOff,
      normalized(TOPIC_BUTTONS.modelCenter),
      normalized(TOPIC_BUTTONS.deleteChat),
      normalized(TOPIC_BUTTONS.topicSettings),
      modelButton,
    ]);
    const mainButtonTexts = new Set([
      normalized(MAIN_BUTTONS.history),
      normalized(MAIN_BUTTONS.newChat),
      normalized(MAIN_BUTTONS.mainSettings),
      normalized(MAIN_BUTTONS.topicSettings),
      normalized(MAIN_BUTTONS.imageAi),
      normalized(MAIN_BUTTONS.deleteChat),
      compactOn,
      compactOff,
      normalized(MAIN_BUTTONS.pause),
      normalized(MAIN_BUTTONS.resume),
      normalized(MAIN_BUTTONS.abort),
      normalized("❌ Cancel"),
      modelButton,
    ]);

    if (topic && mainButtonTexts.has(text) && !topicButtonTexts.has(text)) {
      logger.info(`[Bot] Ignoring stale Main Reply Keyboard button in Topic: thread=${ctx.message.message_thread_id}, text=${raw}`);
      return;
    }

    const activeRouteButtons = topic ? topicButtonTexts : mainButtonTexts;
    const looksLikeButton = activeRouteButtons.has(text) ||
      (!topic && (isReplyKeyboardButtonText(text, new Set([currentModelButton()])) ||
        AGENT_MODE_BUTTON_TEXT_PATTERN.test(text) || CONTEXT_BUTTON_TEXT_PATTERN.test(text) ||
        QUEUED_PROMPT_BUTTON_TEXT_PATTERN.test(text) || VARIANT_BUTTON_TEXT_PATTERN.test(text)));

    if (!looksLikeButton) return next();
    clearImageMode();
    logger.info(`[Bot] Consuming Reply Keyboard control: scope=${topic ? "topic" : "main"} thread=${ctx.message.message_thread_id ?? 0} text=${raw}`);

    try {
      if (isExact(text, TOPIC_BUTTONS.imageAi) || (!topic && isExact(text, MAIN_BUTTONS.imageAi))) {
        await ctx.reply("🎨 <b>Image AI</b>\nChoose an action:", {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text("🖼️ Generate Image", "imageai:generate").text("🖌️ Edit Image", "imageai:edit"),
        });
        return;
      }

      if (isExact(text, TOPIC_BUTTONS.pause) || (!topic && isExact(text, MAIN_BUTTONS.pause))) {
        await pauseCurrentChat(ctx);
        return;
      }

      if (isExact(text, TOPIC_BUTTONS.resume) || (!topic && isExact(text, MAIN_BUTTONS.resume))) {
        await resumePausedChat(ctx, { bot: deps.bot, ensureEventSubscription: deps.ensureEventSubscription });
        return;
      }

      if (isExact(text, TOPIC_BUTTONS.abort) || (!topic && isExact(text, MAIN_BUTTONS.abort))) {
        await abortCurrentOperation(ctx);
        return;
      }

      if (isExact(text, "❌ Cancel")) {
        if (isProviderWizardActive()) {
          clearProviderWizard(); clearIntegrationWizard(); await providersCommand(ctx as never); return;
        }
        if (isIntegrationWizardActive()) {
          clearIntegrationWizard(); clearProviderWizard(); await integrationsCommand(ctx as never); return;
        }
        return;
      }

      if (isExact(text, TOPIC_BUTTONS.modelCenter) || (!topic && isExact(text, modelButton))) {
        if (!await menuAllowed(ctx)) return;
        await showModelCenterMenu(ctx);
        return;
      }

      if (topic && (isExact(text, compactOn) || isExact(text, compactOff))) {
        if (!await menuAllowed(ctx)) return;
        const enabled = !getCompactOutputMode();
        setCompactOutputMode(enabled);
        const keyboard = keyboardManager.getKeyboard();
        await ctx.reply(`📦 Compact Mode: ${enabled ? "ON" : "OFF"}`, keyboard ? { reply_markup: keyboard } : {});
        return;
      }

      if (!topic && (isExact(text, compactOn) || isExact(text, compactOff))) {
        if (!await menuAllowed(ctx)) return;
        const enabled = !getCompactOutputMode();
        setCompactOutputMode(enabled);
        const keyboard = keyboardManager.getKeyboard();
        await ctx.reply(`📦 Compact Mode: ${enabled ? "ON" : "OFF"}`, keyboard ? { reply_markup: keyboard } : {});
        return;
      }

      if (topic && isExact(text, TOPIC_BUTTONS.topicSettings)) {
        if (await menuAllowed(ctx)) await settingsCommand(ctx as never);
        return;
      }

      if (topic && isExact(text, TOPIC_BUTTONS.deleteChat)) {
        await showTelegramTopicDeleteConfirmation(ctx);
        return;
      }

      if (!topic && isExact(text, MAIN_BUTTONS.history)) {
        if (await menuAllowed(ctx)) await sessionsCommand(ctx as never);
        return;
      }
      if (!topic && isExact(text, MAIN_BUTTONS.newChat)) {
        if (await menuAllowed(ctx)) await newCommand(ctx as never, deps);
        return;
      }
      if (!topic && (isExact(text, MAIN_BUTTONS.mainSettings) || isExact(text, MAIN_BUTTONS.topicSettings))) {
        if (await menuAllowed(ctx)) await settingsCommand(ctx as never);
        return;
      }
      if (!topic && AGENT_MODE_BUTTON_TEXT_PATTERN.test(text)) {
        if (await menuAllowed(ctx)) await showAgentSelectionMenu(ctx);
        return;
      }
      if (!topic && CONTEXT_BUTTON_TEXT_PATTERN.test(text)) {
        if (await menuAllowed(ctx)) await handleContextButtonPress(ctx);
        return;
      }
      if (!topic && VARIANT_BUTTON_TEXT_PATTERN.test(text)) {
        if (await menuAllowed(ctx)) await showVariantSelectionMenu(ctx);
        return;
      }
      if (!topic && QUEUED_PROMPT_BUTTON_TEXT_PATTERN.test(text)) {
        if (!await menuAllowed(ctx)) return;
        const queued = findQueuedPromptByButtonLabel(raw);
        const keyboard = keyboardManager.getKeyboard();
        if (queued) {
          promptQueue.removeById(queued.id);
          await ctx.reply(t("queue.removed"), keyboard ? { reply_markup: keyboard } : {});
        } else {
          await ctx.reply(t("queue.not_found"), keyboard ? { reply_markup: keyboard } : {});
        }
        return;
      }

      // A recognized Reply Keyboard label is a control message, never a prompt.
      if (activeRouteButtons.has(text)) return;
    } catch (error) {
      logger.error(`[Bot] Reply Keyboard dispatch failed: ${raw}`, error);
      return;
    }

    return next();
  });
}
