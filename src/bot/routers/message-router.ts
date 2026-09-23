import type { Bot, Context } from "grammy";
import { config } from "../../config.js";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import { questionManager } from "../../app/managers/question-manager.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { handleTaskTextInput } from "../commands/task-command.js";
import { handleProviderWizardMessage, isProviderWizardActive, clearProviderWizard, providersCommand } from "../commands/providers-command.js";
import { handleIntegrationMessage, isIntegrationWizardActive, clearIntegrationWizard, integrationsCommand } from "../commands/integrations-command.js";
import { handleModelSearchTextInput } from "../callbacks/model-center-callback-handler.js";
import { handleQuestionTextAnswer } from "../callbacks/question-callback-handler.js";
import { handleRenameTextAnswer } from "../callbacks/rename-callback-handler.js";
import { handleContextButtonPress } from "../menus/context-control-menu.js";
import { showAgentSelectionMenu } from "../menus/agent-selection-menu.js";
import { showVariantSelectionMenu } from "../menus/variant-selection-menu.js";
import { showModelCenterMenu } from "../menus/model-center-menu.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { formatModelForButton } from "../../app/types/model.js";
import {
  AGENT_MODE_BUTTON_TEXT_PATTERN,
  CONTEXT_BUTTON_TEXT_PATTERN,
  QUEUED_PROMPT_BUTTON_TEXT_PATTERN,
  VARIANT_BUTTON_TEXT_PATTERN,
  isReplyKeyboardButtonText,
} from "../message-patterns.js";
import { promptQueue } from "../../app/managers/prompt-queue-manager.js";
import { keyboardManager } from "../keyboards/keyboard-manager.js";
import { MAIN_BUTTONS } from "../keyboards/main-reply-keyboard.js";
import { findQueuedPromptByButtonLabel } from "../keyboards/queued-prompt-button.js";
import { handleDocumentMessage } from "../handlers/document-handler.js";
import { createMediaGroupAttachmentMiddleware } from "../handlers/media-group-handler.js";
import { handlePhotoMessage } from "../handlers/photo-handler.js";
import { handleVideoMessage } from "../handlers/video-handler.js";
import { queuePromptForMerging } from "../handlers/message-merger.js";
import { handleCatalogTextArguments } from "../handlers/text-message-handler.js";
import { handleVoiceMessage } from "../handlers/voice-handler.js";
import { unknownCommandMiddleware } from "../middleware/unknown-command.js";
import { isMcpAddWizardActive, isMcpAuthWizardActive } from "../commands/mcp-catalog-command.js";
import { clearSkillWizard, handleSkillWizardMessage, isSkillWizardActive } from "../commands/skills-wizard.js";
import { clearSkillImportFlow, handleSkillImportMessage, isSkillImportActive } from "../commands/skills-import-flow.js";
import { newCommand } from "../commands/new-command.js";
import { pauseCurrentChat, resumePausedChat } from "../commands/pause-command.js";
import { abortCurrentOperation } from "../commands/abort-command.js";
import { sessionsCommand } from "../commands/sessions-command.js";
import { settingsCommand } from "../commands/settings-command.js";
import { closeActiveInlineMenu } from "../menus/inline-menu.js";
import { assistantRunState } from "../../app/managers/assistant-run-state-manager.js";
import { getTopicRuntimeContext } from "../../app/services/topic-runtime-context.js";
import { getCurrentSession } from "../../app/services/session-service.js";
import { getCompactOutputMode, setCompactOutputMode } from "../../app/stores/settings-store.js";
import { agentArtifactDeliveryService } from "../services/agent-artifact-delivery-service.js";

interface MessageRouterDeps {
  ensureEventSubscription: (directory: string) => Promise<void>;
  setTelegramContext: (bot: Bot<Context>, chatId: number, sessionId?: string) => void;
}

const CONTROL_TEXT = {
  cancel: "❌ Cancel",
  pause: MAIN_BUTTONS.pause,
  abort: MAIN_BUTTONS.abort,
  resume: MAIN_BUTTONS.resume,
} as const;

let botInstance: Bot<Context> | null = null;
let currentEnsureEventSubscription: ((directory: string) => Promise<void>) | null = null;

function normalizeControlText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\uFE0F/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getCurrentModelButtonText(): string {
  const model = getStoredModel();
  if (!model.providerID || !model.modelID) return "🧠 Model";
  return formatModelForButton(model.providerID, model.modelID, model.name);
}

async function blockMenuWhileInteractionActive(ctx: Context): Promise<boolean> {
  const topic = getTopicRuntimeContext();
  const sessionId = topic?.sessionId ?? getCurrentSession()?.id;
  if (sessionId ? assistantRunState.hasActiveRun(sessionId) : assistantRunState.hasActiveRuns()) return true;

  const activeInteraction = interactionManager.getSnapshot();
  if (!activeInteraction) return false;

  if (activeInteraction.kind === "inline") {
    await closeActiveInlineMenu(ctx, "reply-keyboard-navigation");
    return false;
  }

  logger.debug(
    `[Bot] Blocking menu open while interaction active: kind=${activeInteraction.kind}, expectedInput=${activeInteraction.expectedInput}`,
  );
  await ctx.reply(t("interaction.blocked.finish_current"));
  return true;
}

async function handleCompactModeButton(ctx: Context): Promise<boolean> {
  const buttonText = ctx.message?.text;
  if (!buttonText || buttonText !== MAIN_BUTTONS.compact(getCompactOutputMode())) return false;

  if (await blockMenuWhileInteractionActive(ctx)) return true;

  const enabled = !getCompactOutputMode();
  setCompactOutputMode(enabled);
  const sessionId = getTopicRuntimeContext()?.sessionId;
  const keyboard = keyboardManager.getKeyboard(sessionId);
  await ctx.reply(`📦 Compact Mode: ${enabled ? "ON" : "OFF"}`, keyboard ? { reply_markup: keyboard } : {});
  return true;
}

async function handlePriorityControlButton(ctx: Context): Promise<boolean> {
  const rawText = ctx.message?.text;
  if (!rawText || !ctx.chat?.id) return false;

  const text = normalizeControlText(rawText);

  if (text === normalizeControlText(CONTROL_TEXT.pause)) {
    logger.info(`[Bot] Control button received: Pause chatId=${ctx.chat.id}`);
    await pauseCurrentChat(ctx);
    return true;
  }

  if (text === normalizeControlText(CONTROL_TEXT.resume)) {
    logger.info(`[Bot] Control button received: Resume chatId=${ctx.chat.id}`);
    if (botInstance && currentEnsureEventSubscription) {
      await resumePausedChat(ctx, { bot: botInstance, ensureEventSubscription: currentEnsureEventSubscription });
    }
    return true;
  }

  if (text === normalizeControlText(CONTROL_TEXT.abort)) {
    logger.info(`[Bot] Control button received: Abort chatId=${ctx.chat.id}`);
    await abortCurrentOperation(ctx);
    return true;
  }

  if (text === normalizeControlText(CONTROL_TEXT.cancel)) {
    logger.info(`[Bot] Control button received: Cancel chatId=${ctx.chat.id}`);

    if (isProviderWizardActive()) {
      clearProviderWizard();
      clearIntegrationWizard();
      await providersCommand(ctx as never);
      return true;
    }

    if (isIntegrationWizardActive()) {
      clearIntegrationWizard();
      clearProviderWizard();
      await integrationsCommand(ctx as never);
      return true;
    }

    if (isSkillWizardActive()) {
      clearSkillWizard();
      await ctx.reply(t("common.cancelled"));
      return true;
    }

    if (isSkillImportActive()) {
      clearSkillImportFlow();
      await ctx.reply(t("common.cancelled"));
      return true;
    }
  }

  return false;
}

/**
 * Main/General is a navigation lobby, not an AI conversation surface. Telegram
 * exposes forum mode differently for supergroups (`chat.is_forum`) and private
 * bot chats (`ctx.me.has_topics_enabled`), so both capabilities must be handled.
 * Free-form input is allowed here only while the bot explicitly awaits text for
 * a wizard/question/etc.; actual AI prompts belong in conversation Topics.
 */
function isMainNavigationTopic(ctx: Context): boolean {
  const chat = ctx.chat as { type?: string; is_forum?: boolean } | undefined;
  if (!chat) return false;

  const botInfo = ctx.me as { has_topics_enabled?: boolean } | undefined;
  const isSupergroupForum = chat.type !== "private" && chat.is_forum === true;
  const isPrivateBotForum = chat.type === "private" && botInfo?.has_topics_enabled === true;
  if (!isSupergroupForum && !isPrivateBotForum) return false;

  const threadId = (ctx.message as { message_thread_id?: number } | undefined)?.message_thread_id;
  return typeof threadId !== "number" || threadId <= 1;
}

function isBotAwaitingTextInput(): boolean {
  const state = interactionManager.getSnapshot();
  if (state && (state.expectedInput === "text" || state.expectedInput === "mixed")) return true;
  return (
    isProviderWizardActive() ||
    isIntegrationWizardActive() ||
    isMcpAddWizardActive() ||
    isMcpAuthWizardActive() ||
    isSkillWizardActive() ||
    isSkillImportActive()
  );
}

function isGeneralTopicPromptBlocked(ctx: Context): boolean {
  return isMainNavigationTopic(ctx) && !isBotAwaitingTextInput();
}

async function rejectGeneralTopicPrompt(ctx: Context): Promise<void> {
  await ctx.reply(t("general.topic_only_prompt"));
}

function installTextRouting(bot: Bot<Context>, deps: MessageRouterDeps): void {
  bot.on("message:text", async (ctx, next) => {
    if (!ctx.chat) { await next(); return; }
    const rawText = ctx.message.text;
    const text = rawText.trim();
    if (!text) return;

    const sessionId = getTopicRuntimeContext()?.sessionId ?? getCurrentSession()?.id;
    deps.setTelegramContext(bot, ctx.chat.id, sessionId);
    agentArtifactDeliveryService.setChatId(ctx.chat.id);

    logger.debug(`[Bot] Received text message: ${text.startsWith("/") ? `command=\"${text}\"` : `prompt (length=${text.length})`}, chatId=${ctx.chat.id}`);

    if (await handlePriorityControlButton(ctx)) return;

    if (text.startsWith("/")) {
      await next();
      return;
    }

    // Reply-keyboard presses arrive from Telegram as normal text messages.
    // Dynamic model labels are recognized only by exact current-label matching;
    // this prevents ordinary prompts such as "🧠 Explain this architecture 2026" from being controls.
    const knownReplyKeyboardButtonTexts = new Set<string>([getCurrentModelButtonText()]);
    if (isReplyKeyboardButtonText(text, knownReplyKeyboardButtonTexts)) {
      await next();
      return;
    }

    if (await handleProviderWizardMessage(ctx)) return;
    if (await handleIntegrationMessage(ctx)) return;
    if (await handleSkillWizardMessage(ctx)) return;
    if (await handleSkillImportMessage(ctx)) return;
    if (questionManager.isActive()) {
      await handleQuestionTextAnswer(ctx);
      return;
    }
    if (await handleTaskTextInput(ctx)) return;
    if (await handleModelSearchTextInput(ctx)) return;
    if (await handleRenameTextAnswer(ctx)) return;

    const promptDeps = { bot, ensureEventSubscription: deps.ensureEventSubscription };
    if (await handleCatalogTextArguments(ctx, promptDeps)) return;

    if (isGeneralTopicPromptBlocked(ctx)) {
      await rejectGeneralTopicPrompt(ctx);
      return;
    }

    queuePromptForMerging(ctx, text, promptDeps, config.bot.messageMergeWindowMs);
  });
}

export function registerMessageRouter(bot: Bot<Context>, deps: MessageRouterDeps): void {
  botInstance = bot;
  currentEnsureEventSubscription = deps.ensureEventSubscription;

  bot.on("message", async (ctx, next) => {
    if (!ctx.chat) {
      await next();
      return;
    }
    agentArtifactDeliveryService.setChatId(ctx.chat.id);
    const sessionId = getTopicRuntimeContext()?.sessionId ?? getCurrentSession()?.id;
    deps.setTelegramContext(bot, ctx.chat.id, sessionId);
    await next();
  });

  installTextRouting(bot, deps);
  bot.on("message:text", unknownCommandMiddleware);

  bot.hears(/^❌ Cancel$/, async (ctx) => {
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
    }
  });

  bot.hears(/^⚙️ Settings$/, async (ctx) => {
    if (await blockMenuWhileInteractionActive(ctx)) return;
    await settingsCommand(ctx as never);
  });

  bot.hears(/^🕘 History$/, async (ctx) => {
    if (await blockMenuWhileInteractionActive(ctx)) return;
    await sessionsCommand(ctx as never);
  });

  bot.hears(/^💬 New Chat$/, async (ctx) => {
    if (await blockMenuWhileInteractionActive(ctx)) return;
    await newCommand(ctx as never, { bot, ensureEventSubscription: deps.ensureEventSubscription });
  });

  bot.hears(/^📦 Compact: (?:ON|OFF)$/, handleCompactModeButton);

  bot.hears(QUEUED_PROMPT_BUTTON_TEXT_PATTERN, async (ctx) => {
    if (await blockMenuWhileInteractionActive(ctx)) return;

    const label = ctx.message?.text;
    const queuedPrompt = label ? findQueuedPromptByButtonLabel(label) : null;
    const sessionId = getTopicRuntimeContext()?.sessionId;
    const keyboard = keyboardManager.getKeyboard(sessionId);
    if (queuedPrompt) {
      promptQueue.removeById(queuedPrompt.id);
      await ctx.reply(t("queue.removed"), keyboard ? { reply_markup: keyboard } : {});
      return;
    }
    await ctx.reply(t("queue.not_found"), keyboard ? { reply_markup: keyboard } : {});
  });

  bot.hears(AGENT_MODE_BUTTON_TEXT_PATTERN, async (ctx) => {
    try {
      if (await blockMenuWhileInteractionActive(ctx)) return;
      await showAgentSelectionMenu(ctx);
    } catch (err) {
      logger.error("[Bot] Error showing agent menu:", err);
      await ctx.reply(t("error.load_agents"));
    }
  });

  bot.on("message:text", async (ctx, next) => {
    if (normalizeControlText(ctx.message.text) !== normalizeControlText(getCurrentModelButtonText())) {
      await next();
      return;
    }

    try {
      if (await blockMenuWhileInteractionActive(ctx)) return;
      await showModelCenterMenu(ctx);
    } catch (err) {
      logger.error("[Bot] Error showing model center:", err);
      await ctx.reply(t("error.load_models"));
    }
  });

  bot.hears(CONTEXT_BUTTON_TEXT_PATTERN, async (ctx) => {
    try {
      if (await blockMenuWhileInteractionActive(ctx)) return;
      await handleContextButtonPress(ctx);
    } catch (err) {
      logger.error("[Bot] Error handling context button:", err);
      await ctx.reply(t("error.context_button"));
    }
  });

  bot.hears(VARIANT_BUTTON_TEXT_PATTERN, async (ctx) => {
    try {
      if (await blockMenuWhileInteractionActive(ctx)) return;
      await showVariantSelectionMenu(ctx);
    } catch (err) {
      logger.error("[Bot] Error showing variants menu:", err);
      await ctx.reply(t("error.load_variants"));
    }
  });

  const voicePromptDeps = { bot, ensureEventSubscription: deps.ensureEventSubscription };
  bot.on("message:voice", async (ctx, next) => {
    if (!ctx.chat) { await next(); return; }
    if (isGeneralTopicPromptBlocked(ctx)) {
      await rejectGeneralTopicPrompt(ctx);
      return;
    }
    const sessionId = getTopicRuntimeContext()?.sessionId ?? getCurrentSession()?.id;
    deps.setTelegramContext(bot, ctx.chat.id, sessionId);
    agentArtifactDeliveryService.setChatId(ctx.chat.id);
    await handleVoiceMessage(ctx, voicePromptDeps);
  });

  bot.on("message:audio", async (ctx, next) => {
    if (!ctx.chat) { await next(); return; }
    if (isGeneralTopicPromptBlocked(ctx)) {
      await rejectGeneralTopicPrompt(ctx);
      return;
    }
    const sessionId = getTopicRuntimeContext()?.sessionId ?? getCurrentSession()?.id;
    deps.setTelegramContext(bot, ctx.chat.id, sessionId);
    agentArtifactDeliveryService.setChatId(ctx.chat.id);
    await handleVoiceMessage(ctx, voicePromptDeps);
  });

  const mediaGroupMiddleware = createMediaGroupAttachmentMiddleware({ bot, ensureEventSubscription: deps.ensureEventSubscription });
  bot.on("message", async (ctx, next) => {
    if (ctx.message?.media_group_id && isGeneralTopicPromptBlocked(ctx)) {
      await rejectGeneralTopicPrompt(ctx);
      return;
    }
    await mediaGroupMiddleware(ctx, next);
  });

  bot.on("message:photo", async (ctx, next) => {
    if (!ctx.chat) { await next(); return; }
    const sessionId = getTopicRuntimeContext()?.sessionId ?? getCurrentSession()?.id;
    deps.setTelegramContext(bot, ctx.chat.id, sessionId);
    agentArtifactDeliveryService.setChatId(ctx.chat.id);

    if (isGeneralTopicPromptBlocked(ctx)) {
      await rejectGeneralTopicPrompt(ctx);
      return;
    }

    await handlePhotoMessage(ctx, { bot, ensureEventSubscription: deps.ensureEventSubscription });
  });

  bot.on("message:video", async (ctx, next) => {
    if (!ctx.chat) { await next(); return; }
    const sessionId = getTopicRuntimeContext()?.sessionId ?? getCurrentSession()?.id;
    deps.setTelegramContext(bot, ctx.chat.id, sessionId);
    agentArtifactDeliveryService.setChatId(ctx.chat.id);

    if (isGeneralTopicPromptBlocked(ctx)) {
      await rejectGeneralTopicPrompt(ctx);
      return;
    }

    await handleVideoMessage(ctx, { bot, ensureEventSubscription: deps.ensureEventSubscription });
  });

  bot.on("message:video_note", async (ctx, next) => {
    if (!ctx.chat) { await next(); return; }
    const sessionId = getTopicRuntimeContext()?.sessionId ?? getCurrentSession()?.id;
    deps.setTelegramContext(bot, ctx.chat.id, sessionId);
    agentArtifactDeliveryService.setChatId(ctx.chat.id);

    if (isGeneralTopicPromptBlocked(ctx)) {
      await rejectGeneralTopicPrompt(ctx);
      return;
    }

    await handleVideoMessage(ctx, { bot, ensureEventSubscription: deps.ensureEventSubscription });
  });

  bot.on("message:document", async (ctx, next) => {
    if (!ctx.chat) { await next(); return; }
    if (isGeneralTopicPromptBlocked(ctx)) {
      await rejectGeneralTopicPrompt(ctx);
      return;
    }
    const sessionId = getTopicRuntimeContext()?.sessionId ?? getCurrentSession()?.id;
    deps.setTelegramContext(bot, ctx.chat.id, sessionId);
    agentArtifactDeliveryService.setChatId(ctx.chat.id);
    await handleDocumentMessage(ctx, { bot, ensureEventSubscription: deps.ensureEventSubscription });
  });
}
