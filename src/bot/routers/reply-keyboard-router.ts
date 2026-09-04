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

interface ReplyKeyboardRouterDeps {
  bot: Bot<Context>;
  ensureEventSubscription: (directory: string) => Promise<void>;
}

function normalized(text: string): string {
  return text.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\uFE0F/g, "").replace(/\s+/g, " ").trim();
}

function currentModelButton(): string {
  const model = getStoredModel();
  return model.providerID && model.modelID ? formatModelForButton(model.providerID, model.modelID, model.name) : "🧠 Model";
}

function isTopicRoute(): boolean {
  const context = getTopicRuntimeContext();
  return Boolean(context?.sessionId && context.threadId !== undefined);
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

export function registerReplyKeyboardRouter(bot: Bot<Context>, deps: ReplyKeyboardRouterDeps): void {
  bot.on("message:text", async (ctx, next) => {
    const raw = ctx.message.text;
    const text = normalized(raw);
    if (!text) return next();

    const topic = isTopicRoute();
    const modelButton = normalized(currentModelButton());
    const topicButtonTexts = new Set([
      normalized(TOPIC_BUTTONS.abort),
      normalized(TOPIC_BUTTONS.pause),
      normalized(TOPIC_BUTTONS.resume),
      normalized(TOPIC_BUTTONS.imageAi),
      normalized(TOPIC_BUTTONS.modelCenter),
      normalized(TOPIC_BUTTONS.deleteChat),
      normalized(TOPIC_BUTTONS.topicSettings),
    ]);
    const mainButtonTexts = new Set([
      normalized(MAIN_BUTTONS.history),
      normalized(MAIN_BUTTONS.newChat),
      normalized(MAIN_BUTTONS.mainSettings),
      normalized(MAIN_BUTTONS.topicSettings),
      normalized(MAIN_BUTTONS.imageAi),
      normalized(MAIN_BUTTONS.deleteChat),
      normalized(MAIN_BUTTONS.compact(getCompactOutputMode())),
      normalized(MAIN_BUTTONS.compact(!getCompactOutputMode())),
      normalized(MAIN_BUTTONS.pause),
      normalized(MAIN_BUTTONS.resume),
      normalized(MAIN_BUTTONS.abort),
      normalized("❌ Cancel"),
      modelButton,
    ]);

    const activeRouteButtons = topic ? topicButtonTexts : mainButtonTexts;
    const looksLikeButton = activeRouteButtons.has(text) ||
      (!topic && (isReplyKeyboardButtonText(text, new Set([currentModelButton()])) ||
        AGENT_MODE_BUTTON_TEXT_PATTERN.test(text) || CONTEXT_BUTTON_TEXT_PATTERN.test(text) ||
        QUEUED_PROMPT_BUTTON_TEXT_PATTERN.test(text) || VARIANT_BUTTON_TEXT_PATTERN.test(text)));

    // A stale Main keyboard can remain visible in a Topic client until Telegram
    // receives a newer reply keyboard. Never let those stale labels become prompts.
    if (topic && mainButtonTexts.has(text) && !topicButtonTexts.has(text)) {
      logger.info(`[Bot] Ignoring stale Main Reply Keyboard button in Topic: thread=${getTopicRuntimeContext()?.threadId}, text=${raw}`);
      return;
    }

    if (!looksLikeButton) return next();

    clearImageMode();

    try {
      if (isExact(text, TOPIC_BUTTONS.imageAi) || isExact(text, MAIN_BUTTONS.imageAi)) {
        await ctx.reply("🎨 <b>Image AI</b>\nChoose an action:", {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text("🖼️ Generate Image", "imageai:generate").text("🖌️ Edit Image", "imageai:edit"),
        });
        return;
      }

      if (isExact(text, TOPIC_BUTTONS.pause) || isExact(text, MAIN_BUTTONS.pause)) {
        logger.info(`[Bot] Reply Keyboard dispatch: Pause chatId=${ctx.chat.id} topic=${topic}`);
        await pauseCurrentChat(ctx);
        return;
      }

      if (isExact(text, TOPIC_BUTTONS.resume) || isExact(text, MAIN_BUTTONS.resume)) {
        logger.info(`[Bot] Reply Keyboard dispatch: Resume chatId=${ctx.chat.id} topic=${topic}`);
        await resumePausedChat(ctx, { bot: deps.bot, ensureEventSubscription: deps.ensureEventSubscription });
        return;
      }

      if (isExact(text, TOPIC_BUTTONS.abort) || isExact(text, MAIN_BUTTONS.abort)) {
        logger.info(`[Bot] Reply Keyboard dispatch: Abort chatId=${ctx.chat.id} topic=${topic}`);
        await abortCurrentOperation(ctx);
        return;
      }

      if (isExact(text, "❌ Cancel")) {
        if (isProviderWizardActive()) {
          clearProviderWizard();
          clearIntegrationWizard();
          await providersCommand(ctx as never);
          return;
        }
        if (isIntegrationWizardActive()) {
          clearIntegrationWizard();
          clearProviderWizard();
          await integrationsCommand(ctx as never);
          return;
        }
        return;
      }

      if (topic && isExact(text, TOPIC_BUTTONS.topicSettings)) {
        if (await menuAllowed(ctx)) await settingsCommand(ctx as never);
        return;
      }

      if (topic && isExact(text, TOPIC_BUTTONS.modelCenter)) {
        if (await menuAllowed(ctx)) await showModelCenterMenu(ctx);
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

      if (!topic && (isExact(text, MAIN_BUTTONS.compact(getCompactOutputMode())) || isExact(text, MAIN_BUTTONS.compact(!getCompactOutputMode())))) {
        if (!await menuAllowed(ctx)) return;
        const enabled = !getCompactOutputMode();
        setCompactOutputMode(enabled);
        const keyboard = keyboardManager.getKeyboard();
        await ctx.reply(`📦 Compact Mode: ${enabled ? "ON" : "OFF"}`, keyboard ? { reply_markup: keyboard } : {});
        return;
      }

      if (!topic && isExact(text, modelButton)) {
        if (await menuAllowed(ctx)) await showModelCenterMenu(ctx);
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

      if (topic && isExact(text, TOPIC_BUTTONS.deleteChat)) {
        await showTelegramTopicDeleteConfirmation(ctx);
        return;
      }

      // Consume any recognized active-route keyboard label even when a future
      // route-specific action has not been wired yet; never fall through to the prompt pipeline.
      if (activeRouteButtons.has(text)) return;
    } catch (error) {
      logger.error(`[Bot] Reply Keyboard dispatch failed: ${raw}`, error);
      return;
    }

    return next();
  });
}
