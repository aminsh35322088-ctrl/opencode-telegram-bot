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
import { getCurrentSession } from "../../app/services/session-service.js";
import { showTelegramTopicDeleteConfirmation } from "../services/telegram-topic-delete-handler.js";
import { findTelegramTopicBindingByThread } from "../../app/services/telegram-topic-store.js";
import { isMainTelegramTopic } from "../../app/services/telegram-main-topic-store.js";

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

async function isTopicMessage(ctx: Context): Promise<boolean> {
  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id;
  if (typeof chatId !== "number" || typeof threadId !== "number" || threadId === 1) return false;
  if (await isMainTelegramTopic(chatId, threadId)) return false;
  const runtime = getTopicRuntimeContext();
  if (runtime?.chatId === chatId && runtime.threadId === threadId && runtime.sessionId) return true;
  return Boolean(await findTelegramTopicBindingByThread(chatId, threadId));
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

export function registerReplyKeyboardRouter(bot: Bot<Context>, deps: { bot: Bot<Context>; ensureEventSubscription: (directory: string) => Promise<void> }): void {
  bot.on("message:text", async (ctx, next) => {
    const raw = ctx.message.text;
    const text = normalized(raw);
    if (!text) return next();

    const topic = await isTopicMessage(ctx);
    const runtime = getTopicRuntimeContext();
    const topicState = topic && runtime ? keyboardManager.getState(runtime.sessionId) : undefined;
    const topicModelRaw = topic && topicState?.currentModel?.providerID && topicState.currentModel.modelID
      ? formatModelForButton(topicState.currentModel.providerID, topicState.currentModel.modelID, topicState.currentModel.name)
      : "";
    const modelButton = normalized(currentModelButton());
    const topicModelButton = topicModelRaw ? normalized(topicModelRaw) : "";
    const compactOn = normalized(MAIN_BUTTONS.compact(true));
    const compactOff = normalized(MAIN_BUTTONS.compact(false));

    // Use the actual rendered keyboard as the first line of defense. This keeps
    // future topic buttons from ever leaking into prompt routing just because a
    // new label was added without updating this router in the same commit.
    const renderedButtonTexts = keyboardButtonTexts(
      topic ? keyboardManager.getKeyboard(runtime?.sessionId) : keyboardManager.getKeyboard(),
    ).map(normalized);

    const exactControls = new Set<string>([
      normalized(MAIN_BUTTONS.history), normalized(MAIN_BUTTONS.newChat),
      normalized(MAIN_BUTTONS.mainSettings), normalized(MAIN_BUTTONS.topicSettings),
      normalized(MAIN_BUTTONS.imageAi), normalized(MAIN_BUTTONS.deleteChat),
      normalized(MAIN_BUTTONS.pause), normalized(MAIN_BUTTONS.resume),
      normalized(MAIN_BUTTONS.abort), normalized(TOPIC_BUTTONS.modelCenter),
      normalized("❌ Cancel"), compactOn, compactOff, modelButton,
      ...renderedButtonTexts,
    ]);
    if (topicModelButton) exactControls.add(topicModelButton);

    const dynamicControl =
      isReplyKeyboardButtonText(text, new Set(topicModelRaw ? [currentModelButton(), topicModelRaw] : [currentModelButton()])) ||
      AGENT_MODE_BUTTON_TEXT_PATTERN.test(text) || CONTEXT_BUTTON_TEXT_PATTERN.test(text) ||
      QUEUED_PROMPT_BUTTON_TEXT_PATTERN.test(text) || VARIANT_BUTTON_TEXT_PATTERN.test(text);

    if (!exactControls.has(text) && !dynamicControl) return next();

    clearImageMode();
    logger.info(`[Bot] Consuming Reply Keyboard control: scope=${topic ? "topic" : "main"} thread=${ctx.message.message_thread_id ?? 0} text=${raw}`);

    const mainOnly = new Set([
      normalized(MAIN_BUTTONS.history), normalized(MAIN_BUTTONS.newChat),
      normalized(MAIN_BUTTONS.mainSettings),
    ]);
    const topicOnly = new Set([
      normalized(TOPIC_BUTTONS.deleteChat), normalized(TOPIC_BUTTONS.topicSettings),
      normalized(TOPIC_BUTTONS.modelCenter),
      normalized(MAIN_BUTTONS.imageAi), normalized(MAIN_BUTTONS.pause),
      normalized(MAIN_BUTTONS.resume), normalized(MAIN_BUTTONS.abort), compactOn, compactOff,
    ]);

    const allowedInRoute = topic
      ? topicOnly.has(text) || dynamicControl
      : mainOnly.has(text) || dynamicControl || text === modelButton;

    if (!allowedInRoute) {
      logger.info(`[Bot] Consumed stale/wrong-scope Reply Keyboard button: scope=${topic ? "topic" : "main"} thread=${ctx.message.message_thread_id ?? 0} text=${raw}`);
      return;
    }

    try {
      if (topic && isExact(text, TOPIC_BUTTONS.imageAi)) {
        await ctx.reply("🎨 <b>Image AI</b>\nChoose an action:", { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🖼️ Generate Image", "imageai:generate").text("🖌️ Edit Image", "imageai:edit") }); return;
      }
      if (topic && isExact(text, TOPIC_BUTTONS.pause)) { await pauseCurrentChat(ctx); return; }
      if (topic && isExact(text, TOPIC_BUTTONS.resume)) { await resumePausedChat(ctx, { bot: deps.bot, ensureEventSubscription: deps.ensureEventSubscription }); return; }
      if (topic && isExact(text, TOPIC_BUTTONS.abort)) { await abortCurrentOperation(ctx); return; }
      if (isExact(text, "❌ Cancel")) {
        if (isProviderWizardActive()) { clearProviderWizard(); await providersCommand(ctx as never); return; }
        if (isIntegrationWizardActive()) { clearIntegrationWizard(); await integrationsCommand(ctx as never); return; }
        return;
      }
      if (topic && topicModelButton && isExact(text, topicModelButton)) { if (await menuAllowed(ctx)) await showModelCenterMenu(ctx); return; }
      if (topic && isExact(text, TOPIC_BUTTONS.modelCenter)) { if (await menuAllowed(ctx)) await showModelCenterMenu(ctx); return; }
      if (topic && AGENT_MODE_BUTTON_TEXT_PATTERN.test(text)) { if (await menuAllowed(ctx)) await showAgentSelectionMenu(ctx); return; }
      if (topic && VARIANT_BUTTON_TEXT_PATTERN.test(text)) { if (await menuAllowed(ctx)) await showVariantSelectionMenu(ctx); return; }
      if (topic && CONTEXT_BUTTON_TEXT_PATTERN.test(text)) { if (await menuAllowed(ctx)) await handleContextButtonPress(ctx); return; }
      if (topic && QUEUED_PROMPT_BUTTON_TEXT_PATTERN.test(text)) {
        if (!await menuAllowed(ctx)) return;
        const queued = findQueuedPromptByButtonLabel(raw); const keyboard = keyboardManager.getKeyboard(runtime?.sessionId);
        if (queued) { promptQueue.removeById(queued.id); await ctx.reply(t("queue.removed"), keyboard ? { reply_markup: keyboard } : {}); }
        else await ctx.reply(t("queue.not_found"), keyboard ? { reply_markup: keyboard } : {});
        return;
      }
      if (!topic && isExact(text, modelButton)) { if (await menuAllowed(ctx)) await showModelCenterMenu(ctx); return; }
      if (isExact(text, compactOn) || isExact(text, compactOff)) {
        if (!await menuAllowed(ctx)) return;
        const enabled = !getCompactOutputMode(); setCompactOutputMode(enabled);
        const sessionId = topic ? getTopicRuntimeContext()?.sessionId : undefined;
        const keyboard = keyboardManager.getKeyboard(sessionId);
        await ctx.reply(`📦 Compact Mode: ${enabled ? "ON" : "OFF"}`, keyboard ? { reply_markup: keyboard } : {}); return;
      }
      if (topic && isExact(text, TOPIC_BUTTONS.topicSettings)) { if (await menuAllowed(ctx)) await settingsCommand(ctx as never); return; }
      if (topic && isExact(text, TOPIC_BUTTONS.deleteChat)) { await showTelegramTopicDeleteConfirmation(ctx); return; }
      if (!topic && isExact(text, MAIN_BUTTONS.history)) { if (await menuAllowed(ctx)) await sessionsCommand(ctx as never); return; }
      if (!topic && isExact(text, MAIN_BUTTONS.newChat)) { if (await menuAllowed(ctx)) await newCommand(ctx as never, deps); return; }
      if (!topic && isExact(text, MAIN_BUTTONS.mainSettings)) { if (await menuAllowed(ctx)) await settingsCommand(ctx as never); return; }
      if (!topic && AGENT_MODE_BUTTON_TEXT_PATTERN.test(text)) { if (await menuAllowed(ctx)) await showAgentSelectionMenu(ctx); return; }
      if (!topic && CONTEXT_BUTTON_TEXT_PATTERN.test(text)) { if (await menuAllowed(ctx)) await handleContextButtonPress(ctx); return; }
      if (!topic && VARIANT_BUTTON_TEXT_PATTERN.test(text)) { if (await menuAllowed(ctx)) await showVariantSelectionMenu(ctx); return; }
      if (!topic && QUEUED_PROMPT_BUTTON_TEXT_PATTERN.test(text)) {
        if (!await menuAllowed(ctx)) return;
        const queued = findQueuedPromptByButtonLabel(raw); const keyboard = keyboardManager.getKeyboard();
        if (queued) { promptQueue.removeById(queued.id); await ctx.reply(t("queue.removed"), keyboard ? { reply_markup: keyboard } : {}); }
        else await ctx.reply(t("queue.not_found"), keyboard ? { reply_markup: keyboard } : {});
        return;
      }
      return;
    } catch (error) {
      logger.error(`[Bot] Reply Keyboard dispatch failed: ${raw}`, error);
      return;
    }
  });
}
