import type { Bot, Context, NextFunction } from "grammy";
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
import { MAIN_BUTTONS, TOPIC_BUTTONS, TOPIC_CONTROL_CALLBACKS } from "../keyboards/main-reply-keyboard.js";
import { keyboardManager } from "../keyboards/keyboard-manager.js";
import { findQueuedPromptByButtonLabel } from "../keyboards/queued-prompt-button.js";
import { promptQueue } from "../../app/managers/prompt-queue-manager.js";
import { isProviderWizardActive, clearProviderWizard, providersCommand } from "../commands/providers-command.js";
import { isIntegrationWizardActive, clearIntegrationWizard, integrationsCommand } from "../commands/integrations-command.js";
import {
  AGENT_MODE_BUTTON_TEXT_PATTERN,
  CONTEXT_BUTTON_TEXT_PATTERN,
  QUEUED_PROMPT_BUTTON_TEXT_PATTERN,
  VARIANT_BUTTON_TEXT_PATTERN,
} from "../message-patterns.js";
import { getTopicRuntimeContext } from "../../app/services/topic-runtime-context.js";
import { getCurrentSession } from "../../app/services/session-service.js";
import { showTelegramTopicDeleteConfirmation } from "../services/telegram-topic-delete-handler.js";
import { findTelegramTopicBindingByThread } from "../../app/services/telegram-topic-store.js";
import { classifyReplyKeyboardInteraction, getRawReplyKeyboardText } from "../interaction-classifier.js";
import { createNewImageChat } from "./image-chat-router.js";

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

function keyboardButtonTexts(keyboard: unknown): string[] {
  const rows = Array.isArray(keyboard)
    ? keyboard
    : typeof keyboard === "object" && keyboard !== null && Array.isArray(Reflect.get(keyboard, "inline_keyboard"))
      ? Reflect.get(keyboard, "inline_keyboard") as unknown[]
      : [];
  return rows.flatMap((row) => {
    if (!Array.isArray(row)) return [];
    return row.flatMap((button) => {
      if (typeof button === "string") return [button];
      if (typeof button === "object" && button !== null && "text" in button) {
        const text = Reflect.get(button, "text");
        return typeof text === "string" ? [text] : [];
      }
      return [];
    });
  }).filter(Boolean);
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
  try { await ctx.api.deleteMessage(chatId, messageId); }
  catch (error) { logger.debug?.(`[Bot] Could not delete Reply Keyboard control message: chat=${chatId} message=${messageId}`, error); }
}

// Telegram does not emit an update simply because the user switches a private
// bot Topic. Main/All therefore owns the only persistent Reply Keyboard. AI
// Topic controls are inline and cannot mutate the chat input keyboard state.
async function applyMainScopeReplyKeyboard(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (typeof chatId !== "number") return;
  try {
    await keyboardManager.applyMainScopeReplyKeyboardOnce(chatId);
  } catch (error) {
    logger.warn(`[Bot] Failed to apply Main controls Reply Keyboard in Main/General: chat=${chatId}`, error);
  }
}

function markAiTopicKeyboardVisible(ctx: Context): void {
  const chatId = ctx.chat?.id;
  if (typeof chatId === "number") keyboardManager.markTopicKeyboardActive(chatId);
}

function getRenderedReplyKeyboardTexts(scope: { topicMode: boolean; aiTopic: boolean }, runtime: ReturnType<typeof getTopicRuntimeContext>): Set<string> {
  const keyboard = scope.topicMode ? keyboardManager.getKeyboard(scope.aiTopic ? runtime?.sessionId : undefined) : keyboardManager.getKeyboard();
  const built = keyboard && typeof (keyboard as { build?: () => unknown }).build === "function" ? (keyboard as { build: () => unknown }).build() : keyboard;
  return new Set(keyboardButtonTexts(built).map(normalized));
}

async function handleTopicInlineControl(ctx: Context, deps: ReplyKeyboardRouterDeps): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("topicctl:")) return;

  const message = ctx.callbackQuery?.message;
  const chatId = message?.chat.id;
  const threadId = message && "message_thread_id" in message ? message.message_thread_id : undefined;
  const runtime = getTopicRuntimeContext();
  if (
    typeof chatId !== "number" ||
    typeof threadId !== "number" ||
    threadId <= 1 ||
    !runtime ||
    runtime.chatId !== chatId ||
    runtime.threadId !== threadId
  ) {
    await ctx.answerCallbackQuery({ text: "This control belongs to an AI Topic.", show_alert: true }).catch(() => {});
    logger.warn(`[Bot] Rejected Topic inline control without matching Topic runtime: data=${data}, chat=${chatId ?? "none"}, thread=${threadId ?? "none"}`);
    return;
  }

  await ctx.answerCallbackQuery().catch(() => {});
  logger.info(`[Bot] Consuming Topic inline control: session=${runtime.sessionId}, thread=${threadId}, data=${data}`);

  try {
    if (data === TOPIC_CONTROL_CALLBACKS.pause) { await pauseCurrentChat(ctx); return; }
    if (data === TOPIC_CONTROL_CALLBACKS.resume) { await resumePausedChat(ctx, deps); return; }
    if (data === TOPIC_CONTROL_CALLBACKS.abort) { await abortCurrentOperation(ctx); return; }
    if (data === TOPIC_CONTROL_CALLBACKS.deleteChat) { await showTelegramTopicDeleteConfirmation(ctx); return; }

    if (data === TOPIC_CONTROL_CALLBACKS.compact) {
      if (!await menuAllowed(ctx)) return;
      setCompactOutputMode(!getCompactOutputMode());
      await keyboardManager.sendKeyboardUpdate(chatId, true, runtime.sessionId);
      return;
    }
    if (data === TOPIC_CONTROL_CALLBACKS.modelCenter) {
      if (await menuAllowed(ctx)) await showModelCenterMenu(ctx);
      return;
    }
    if (data === TOPIC_CONTROL_CALLBACKS.topicSettings) {
      if (await menuAllowed(ctx)) await settingsCommand(ctx as never);
      return;
    }
    if (data === TOPIC_CONTROL_CALLBACKS.imageAi) {
      if (await menuAllowed(ctx)) await createNewImageChat(ctx);
      return;
    }
  } catch (error) {
    logger.error(`[Bot] Topic inline control failed: session=${runtime.sessionId}, data=${data}`, error);
    await ctx.answerCallbackQuery({ text: t("callback.processing_error"), show_alert: true }).catch(() => {});
  }
}

async function handleReplyKeyboardInput(
  ctx: Context,
  next: NextFunction,
  deps: ReplyKeyboardRouterDeps,
): Promise<void> {
  const raw = ctx.message?.text;
  if (typeof raw !== "string") { await next(); return; }
  let text = normalized(raw);
  if (!text) { await next(); return; }

  const scope = await getTopicScope(ctx);
  if (scope.aiTopic) markAiTopicKeyboardVisible(ctx);
  else await applyMainScopeReplyKeyboard(ctx);

  // The classifier is the authoritative prompt/UI boundary. Nothing below is
  // allowed to turn arbitrary text into a Reply Keyboard control.
  const classified = await classifyReplyKeyboardInteraction(ctx);
  if (!classified.isControl) { await next(); return; }

  // Keep stale Topic reply buttons safe during migration. Telegram may retain an
  // old ReplyKeyboardMarkup locally until the persistent Main keyboard replaces
  // it; those labels must be consumed as UI, never forwarded as model prompts.
  const controlRaw = getRawReplyKeyboardText(ctx) ?? raw;
  text = normalized(controlRaw);

  const runtime = getTopicRuntimeContext();
  const renderedButtonTexts = getRenderedReplyKeyboardTexts(scope, runtime);
  const topicState = scope.aiTopic && runtime ? keyboardManager.getState(runtime.sessionId) : undefined;
  const topicModelButton = normalized(TOPIC_BUTTONS.modelCenter(topicState?.currentModel));
  const mainModelButton = normalized(currentModelButton());
  const compactOn = normalized(MAIN_BUTTONS.compact(true));
  const compactOff = normalized(MAIN_BUTTONS.compact(false));

  const exactControls = new Set<string>([
    ...renderedButtonTexts,
    normalized(MAIN_BUTTONS.history), normalized(MAIN_BUTTONS.newChat), normalized(MAIN_BUTTONS.newImageChat), normalized(MAIN_BUTTONS.mainSettings),
    normalized(MAIN_BUTTONS.topicSettings), normalized(MAIN_BUTTONS.imageAi), normalized(MAIN_BUTTONS.deleteChat),
    normalized(MAIN_BUTTONS.pause), normalized(MAIN_BUTTONS.resume), normalized(MAIN_BUTTONS.abort),
    normalized("🧠 Model Center"), normalized("❌ Cancel"), compactOn, compactOff, mainModelButton, topicModelButton,
  ]);

  const dynamicTopicControl = scope.aiTopic && (
    AGENT_MODE_BUTTON_TEXT_PATTERN.test(text) ||
    CONTEXT_BUTTON_TEXT_PATTERN.test(text) ||
    QUEUED_PROMPT_BUTTON_TEXT_PATTERN.test(text) ||
    VARIANT_BUTTON_TEXT_PATTERN.test(text)
  );

  if (!exactControls.has(text) && !dynamicTopicControl) {
    logger.info(`[Bot] Consuming classified Reply Keyboard control without legacy route: thread=${ctx.message?.message_thread_id ?? 0} text=${text} control=${classified.controlId ?? "unknown"}`);
    await consumeReplyKeyboardMessage(ctx);
    return;
  }

  const mainOnly = new Set([
    normalized(MAIN_BUTTONS.history),
    normalized(MAIN_BUTTONS.newChat),
    normalized(MAIN_BUTTONS.newImageChat),
    normalized(MAIN_BUTTONS.mainSettings),
    mainModelButton,
  ]);
  const topicOnly = new Set([normalized(TOPIC_BUTTONS.deleteChat), normalized(TOPIC_BUTTONS.topicSettings), normalized(MAIN_BUTTONS.imageAi), normalized(MAIN_BUTTONS.pause), normalized(MAIN_BUTTONS.resume), normalized(MAIN_BUTTONS.abort), compactOn, compactOff, normalized("🧠 Model Center"), topicModelButton]);
  const allowedInRoute = scope.aiTopic ? topicOnly.has(text) || dynamicTopicControl : mainOnly.has(text);
  if (!allowedInRoute) {
    logger.info(`[Bot] Consuming stale/wrong-scope Reply Keyboard control instead of falling through to prompt: scope=${scope.topicMode ? "topic" : "main"}${scope.topicMode && !scope.aiTopic ? "/general" : ""} thread=${ctx.message?.message_thread_id ?? 0} text=${text}`);
    await consumeReplyKeyboardMessage(ctx);
    return;
  }

  logger.info(`[Bot] Consuming Reply Keyboard control: scope=${scope.aiTopic ? "ai-topic" : scope.topicMode ? "general" : "main"} thread=${ctx.message?.message_thread_id ?? 0} text=${text}`);
  await consumeReplyKeyboardMessage(ctx);
  try {
    if (scope.aiTopic && isExact(text, TOPIC_BUTTONS.pause)) { await pauseCurrentChat(ctx); return; }
    if (scope.aiTopic && isExact(text, TOPIC_BUTTONS.resume)) { await resumePausedChat(ctx, deps); return; }
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
      const queued = findQueuedPromptByButtonLabel(controlRaw);
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
    if (!scope.aiTopic && isExact(text, MAIN_BUTTONS.newChat)) { if (await menuAllowed(ctx)) await newCommand(ctx as never, deps); return; }
    if (!scope.aiTopic && isExact(text, MAIN_BUTTONS.newImageChat)) { if (await menuAllowed(ctx)) await createNewImageChat(ctx); return; }
    if (!scope.aiTopic && isExact(text, MAIN_BUTTONS.mainSettings)) { if (await menuAllowed(ctx)) await settingsCommand(ctx as never); return; }
  } catch (error) { logger.error(`[Bot] Reply Keyboard dispatch failed: ${raw}`, error); }
}

export function registerReplyKeyboardRouter(bot: Bot<Context>, deps: ReplyKeyboardRouterDeps): void {
  bot.callbackQuery(/^topicctl:/, (ctx) => handleTopicInlineControl(ctx, deps));
  bot.use((ctx, next) => handleReplyKeyboardInput(ctx, next, deps));
}
