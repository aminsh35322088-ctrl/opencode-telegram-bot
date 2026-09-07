import type { Bot, Context, NextFunction } from "grammy";
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
import {
  AGENT_MODE_BUTTON_TEXT_PATTERN,
  CONTEXT_BUTTON_TEXT_PATTERN,
  QUEUED_PROMPT_BUTTON_TEXT_PATTERN,
  VARIANT_BUTTON_TEXT_PATTERN,
  isReplyKeyboardButtonText,
} from "../message-patterns.js";
import { getTopicRuntimeContext } from "../../app/services/topic-runtime-context.js";
import { getCurrentSession } from "../../app/services/session-service.js";
import { showTelegramTopicDeleteConfirmation } from "../services/telegram-topic-delete-handler.js";
import { findTelegramTopicBindingByThread } from "../../app/services/telegram-topic-store.js";

function normalized(text: string): string {
  return text.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\uFE0F/g, "").replace(/\s+/g, " ").trim();
}

function currentModelButton(): string {
  const model = getStoredModel();
  return model.providerID && model.modelID ? formatModelForButton(model.providerID, model.modelID, model.name) : "🧠 Model";
}

function keyboardButtonTexts(keyboard: unknown): string[] {
  const rows = (keyboard as { keyboard?: Array<Array<{ text?: string }>> } | undefined)?.keyboard ?? [];
  return rows.flat().map((button) => button.text ?? "").filter(Boolean);
}

async function getTopicScope(ctx: Context): Promise<{ topicMode: boolean; aiTopic: boolean }> {
  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id;
  if (typeof chatId !== "number") return { topicMode: false, aiTopic: false };

  const generalTopicMode = keyboardManager.isTopicMode(chatId) && (typeof threadId !== "number" || threadId <= 1);
  if (generalTopicMode) return { topicMode: true, aiTopic: false };
  if (typeof threadId !== "number" || threadId <= 1) return { topicMode: false, aiTopic: false };

  const runtime = getTopicRuntimeContext();
  if (runtime?.chatId === chatId && runtime.threadId === threadId && runtime.sessionId) return { topicMode: true, aiTopic: true };
  const binding = await findTelegramTopicBindingByThread(chatId, threadId);
  return binding ? { topicMode: true, aiTopic: true } : { topicMode: false, aiTopic: false };
}

function isExact(text: string, candidate: string): boolean { return normalized(text) === normalized(candidate); }

async function menuAllowed(ctx: Context): Promise<boolean> {
  const topic = getTopicRuntimeContext();
  const sessionId = topic?.sessionId ?? getCurrentSession()?.id;
  if (sessionId ? assistantRunState.hasActiveRun(sessionId) : assistantRunState.hasActiveRuns()) return false;
  const interaction = interactionManager.getSnapshot();
  if (!interaction) return true;
  if (interaction.kind === "inline") return true;
  await ctx.reply(t("interaction.blocked.finish_current"));
  return false;
}

async function consumeReplyKeyboardMessage(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  const messageId = ctx.message?.message_id;
  if (typeof chatId !== "number" || typeof messageId !== "number") return;
  try {
    await ctx.api.deleteMessage(chatId, messageId);
  } catch (error) {
    logger.debug?.(`[Bot] Could not delete Reply Keyboard control message: chat=${chatId} message=${messageId}`, error);
  }
}

function getRenderedReplyKeyboardTexts(scope: { topicMode: boolean; aiTopic: boolean }, runtime: ReturnType<typeof getTopicRuntimeContext>): Set<string> {
  const keyboard = scope.topicMode
    ? keyboardManager.getKeyboard(scope.aiTopic ? runtime?.sessionId : undefined)
    : keyboardManager.getKeyboard();
  // grammY's Keyboard.build() is the canonical two-dimensional button array.
  // Reading the built markup avoids relying on private Keyboard internals.
  const built = keyboard && typeof (keyboard as { build?: () => unknown }).build === "function"
    ? (keyboard as { build: () => unknown }).build()
    : keyboard;
  return new Set(keyboardButtonTexts(built).map(normalized));
}

async function handleReplyKeyboardInput(ctx: Context, next: NextFunction): Promise<void> {
  const raw = ctx.message?.text;
  if (typeof raw !== "string") {
    await next();
    return;
  }

  const text = normalized(raw);
  if (!text) {
    await next();
    return;
  }

  const scope = await getTopicScope(ctx);
  const runtime = getTopicRuntimeContext();
  const renderedButtonTexts = getRenderedReplyKeyboardTexts(scope, runtime);
  const topicState = scope.aiTopic && runtime ? keyboardManager.getState(runtime.sessionId) : undefined;
  const topicModelButton = normalized(TOPIC_BUTTONS.modelCenter(topicState?.currentModel));
  const mainModelButton = normalized(currentModelButton());
  const compactOn = normalized(MAIN_BUTTONS.compact(true));
  const compactOff = normalized(MAIN_BUTTONS.compact(false));

  const exactControls = new Set<string>([
    ...renderedButtonTexts,
    normalized(MAIN_BUTTONS.history), normalized(MAIN_BUTTONS.newChat),
    normalized(MAIN_BUTTONS.mainSettings), normalized(MAIN_BUTTONS.topicSettings),
    normalized(MAIN_BUTTONS.imageAi), normalized(MAIN_BUTTONS.deleteChat),
    normalized(MAIN_BUTTONS.pause), normalized(MAIN_BUTTONS.resume), normalized(MAIN_BUTTONS.abort),
    normalized("🧠 Model Center"), normalized("❌ Cancel"),
    compactOn, compactOff, mainModelButton, topicModelButton,
  ]);

  const dynamicTopicControl =
    AGENT_MODE_BUTTON_TEXT_PATTERN.test(text) ||
    CONTEXT_BUTTON_TEXT_PATTERN.test(text) ||
    QUEUED_PROMPT_BUTTON_TEXT_PATTERN.test(text) ||
    VARIANT_BUTTON_TEXT_PATTERN.test(text);
  const knownReplyKeyboardControl = isReplyKeyboardButtonText(text, new Set([mainModelButton, topicModelButton]));

  if (!exactControls.has(text) && !knownReplyKeyboardControl && !dynamicTopicControl) {
    await next();
    return;
  }

  clearImageMode();

  const mainOnly = new Set([
    normalized(MAIN_BUTTONS.history), normalized(MAIN_BUTTONS.newChat),
    normalized(MAIN_BUTTONS.mainSettings), mainModelButton,
  ]);
  const topicOnly = new Set([
    normalized(TOPIC_BUTTONS.deleteChat), normalized(TOPIC_BUTTONS.topicSettings),
    normalized(MAIN_BUTTONS.imageAi), normalized(MAIN_BUTTONS.pause),
    normalized(MAIN_BUTTONS.resume), normalized(MAIN_BUTTONS.abort), compactOn, compactOff,
    normalized("🧠 Model Center"), topicModelButton,
  ]);

  const allowedInRoute = scope.aiTopic ? topicOnly.has(text) || dynamicTopicControl : mainOnly.has(text);
  if (!allowedInRoute) {
    logger.info(`[Bot] Consuming stale/wrong-scope Reply Keyboard control instead of falling through to prompt: scope=${scope.topicMode ? "topic" : "main"}${scope.topicMode && !scope.aiTopic ? "/general" : ""} thread=${ctx.message?.message_thread_id ?? 0} text=${raw}`);
    await consumeReplyKeyboardMessage(ctx);
    return;
  }

  logger.info(`[Bot] Consuming Reply Keyboard control: scope=${scope.aiTopic ? "ai-topic" : scope.topicMode ? "general" : "main"} thread=${ctx.message?.message_thread_id ?? 0} text=${raw}`);
  await consumeReplyKeyboardMessage(ctx);

  try {
    if (scope.aiTopic && isExact(text, TOPIC_BUTTONS.imageAi)) {
      await ctx.reply("🎨 <b>Image AI</b>\nChoose an action:", { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🖼️ Generate Image", "imageai:generate").text("🖌️ Edit Image", "imageai:edit") });
      return;
    }
    if (scope.aiTopic && isExact(text, TOPIC_BUTTONS.pause)) { await pauseCurrentChat(ctx); return; }
    if (scope.aiTopic && isExact(text, TOPIC_BUTTONS.resume)) { await resumePausedChat(ctx, { bot: ctx.api as never as Bot<Context>, ensureEventSubscription: async () => {} }); return; }
    if (scope.aiTopic && isExact(text, TOPIC_BUTTONS.abort)) { await abortCurrentOperation(ctx); return; }
    if (isExact(text, "❌ Cancel")) {
      if (isProviderWizardActive()) { clearProviderWizard(); await providersCommand(ctx as never); return; }
      if (isIntegrationWizardActive()) { clearIntegrationWizard(); await integrationsCommand(ctx as never); return; }
      return;
    }
    if (scope.aiTopic && (isExact(text, topicModelButton) || isExact(text, "🧠 Model Center"))) { if (await menuAllowed(ctx)) await showModelCenterMenu(ctx); return; }
    if (scope.aiTopic && AGENT_MODE_BUTTON_TEXT_PATTERN.test(text)) { if (await menuAllowed(ctx)) await showAgentSelectionMenu(ctx); return; }
    if (scope.aiTopic && VARIANT_BUTTON_TEXT_PATTERN.test(text)) { if (await menuAllowed(ctx)) await showVariantSelectionMenu(ctx); return; }
    if (scope.aiTopic && CONTEXT_BUTTON_TEXT_PATTERN.test(text)) { if (await menuAllowed(ctx)) await handleContextButtonPress(ctx); return; }
    if (scope.aiTopic && QUEUED_PROMPT_BUTTON_TEXT_PATTERN.test(text)) {
      if (!await menuAllowed(ctx)) return;
      const queued = findQueuedPromptByButtonLabel(raw);
      const keyboard = keyboardManager.getKeyboard(runtime?.sessionId);
      if (queued) { promptQueue.removeById(queued.id); await ctx.reply(t("queue.removed"), keyboard ? { reply_markup: keyboard } : {}); }
      else await ctx.reply(t("queue.not_found"), keyboard ? { reply_markup: keyboard } : {});
      return;
    }
    if (!scope.aiTopic && isExact(text, mainModelButton)) { if (await menuAllowed(ctx)) await showModelCenterMenu(ctx); return; }
    if (scope.aiTopic && (isExact(text, compactOn) || isExact(text, compactOff))) {
      if (!await menuAllowed(ctx)) return;
      setCompactOutputMode(!getCompactOutputMode());
      const enabled = getCompactOutputMode();
      const keyboard = keyboardManager.getKeyboard(runtime?.sessionId);
      await ctx.reply(`📦 Compact Mode: ${enabled ? "ON" : "OFF"}`, keyboard ? { reply_markup: keyboard } : {});
      return;
    }
    if (scope.aiTopic && isExact(text, TOPIC_BUTTONS.topicSettings)) { if (await menuAllowed(ctx)) await settingsCommand(ctx as never); return; }
    if (scope.aiTopic && isExact(text, TOPIC_BUTTONS.deleteChat)) { await showTelegramTopicDeleteConfirmation(ctx); return; }
    if (!scope.aiTopic && isExact(text, MAIN_BUTTONS.history)) { if (await menuAllowed(ctx)) await sessionsCommand(ctx as never); return; }
    if (!scope.aiTopic && isExact(text, MAIN_BUTTONS.newChat)) { if (await menuAllowed(ctx)) await newCommand(ctx as never, { bot: ctx.api as never as Bot<Context>, ensureEventSubscription: async () => {} }); return; }
    if (!scope.aiTopic && isExact(text, MAIN_BUTTONS.mainSettings)) { if (await menuAllowed(ctx)) await settingsCommand(ctx as never); return; }
    return;
  } catch (error) {
    logger.error(`[Bot] Reply Keyboard dispatch failed: ${raw}`, error);
    return;
  }
}

export function registerReplyKeyboardRouter(bot: Bot<Context>, deps: { bot: Bot<Context>; ensureEventSubscription: (directory: string) => Promise<void> }): void {
  bot.use(async (ctx, next) => {
    // The Reply Keyboard router is deliberately a global terminal middleware,
    // not a filtered bot.on() listener. Telegram sends keyboard presses as plain
    // text, so this layer must own the decision before any prompt router runs.
    await handleReplyKeyboardInput(ctx, next);
  });
}
