import type { Bot, Context } from "grammy";
import { InputFile, InlineKeyboard } from "grammy";
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
import { downloadPhoto, editImage, editPhotoMessage, handleImageTextPrompt, isMediaAiConfigured } from "../commands/media-command.js";
import { queuePromptForMerging } from "../handlers/message-merger.js";
import { handleCatalogTextArguments } from "../handlers/text-message-handler.js";
import { handleVoiceMessage } from "../handlers/voice-handler.js";
import { unknownCommandMiddleware } from "../middleware/unknown-command.js";
import { newCommand } from "../commands/new-command.js";
import { pauseCurrentChat, resumePausedChat } from "../commands/pause-command.js";
import { abortCurrentOperation } from "../commands/abort-command.js";
import { sessionsCommand } from "../commands/sessions-command.js";
import { settingsCommand } from "../commands/settings-command.js";
import { closeActiveInlineMenu } from "../menus/inline-menu.js";
import { assistantRunState } from "../../app/managers/assistant-run-state-manager.js";
import { getCompactOutputMode, setCompactOutputMode } from "../../app/stores/settings-store.js";
import { agentArtifactDeliveryService } from "../services/agent-artifact-delivery-service.js";
import { clearImageMode, getImageMode } from "../../app/services/image-mode-service.js";

interface MessageRouterDeps {
  ensureEventSubscription: (directory: string) => Promise<void>;
  setTelegramContext: (bot: Bot<Context>, chatId: number) => void;
}

interface PendingImage {
  buffer: Buffer;
  mimeType: string;
  expiresAt: number;
}

const PENDING_IMAGE_TTL_MS = 10 * 60 * 1000;
const CONTROL_TEXT = {
  cancel: "❌ Cancel",
  pause: MAIN_BUTTONS.pause,
  abort: MAIN_BUTTONS.abort,
  resume: MAIN_BUTTONS.resume,
} as const;

let pendingImage: PendingImage | null = null;
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

function resetImageInteraction(): void {
  pendingImage = null;
  clearImageMode();
}

function rememberPendingImage(image: PendingImage): void {
  pendingImage = image;
  setTimeout(() => {
    if (pendingImage !== image) return;
    resetImageInteraction();
    logger.debug("[Bot] Pending Image AI edit expired and was cleared");
  }, PENDING_IMAGE_TTL_MS).unref?.();
}

async function handleImageModeText(ctx: Context, text: string): Promise<boolean> {
  const mode = getImageMode();
  if (!mode) return false;

  const image = pendingImage;
  pendingImage = null;
  clearImageMode();

  if (mode === "edit") {
    if (!image || image.expiresAt <= Date.now()) {
      await ctx.reply("🖌️ Edit mode is active. Send a photo first, then send the edit instruction.");
      return true;
    }

    if (!(await isMediaAiConfigured())) {
      await ctx.reply("🎨 Image AI is not configured. Open /providers and add the image provider.");
      return true;
    }

    try {
      await ctx.replyWithChatAction("upload_photo");
      const result = await editImage(image.buffer, image.mimeType, text);
      await ctx.replyWithPhoto(new InputFile(result.buffer, `edited.${result.mimeType.split("/")[1] ?? "png"}`), {
        caption: "✨ Edited with Image AI",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[Bot] Image editing failed:", error);
      await ctx.reply(`❌ Image editing failed: ${message}`);
    }
    return true;
  }

  await handleImageTextPrompt(ctx, text);
  return true;
}

async function blockMenuWhileInteractionActive(ctx: Context): Promise<boolean> {
  if (assistantRunState.hasActiveRuns()) return true;

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

  resetImageInteraction();
  if (await blockMenuWhileInteractionActive(ctx)) return true;

  const enabled = !getCompactOutputMode();
  setCompactOutputMode(enabled);
  const keyboard = keyboardManager.getKeyboard();
  await ctx.reply(`📦 Compact Mode: ${enabled ? "ON" : "OFF"}`, keyboard ? { reply_markup: keyboard } : {});
  return true;
}

async function handlePriorityControlButton(ctx: Context): Promise<boolean> {
  const rawText = ctx.message?.text;
  if (!rawText || !ctx.chat?.id) return false;

  const text = normalizeControlText(rawText);

  if (text === normalizeControlText(MAIN_BUTTONS.imageAi)) {
    resetImageInteraction();
    const keyboard = new InlineKeyboard()
      .text("🖼️ Generate Image", "imageai:generate")
      .text("🖌️ Edit Image", "imageai:edit");
    await ctx.reply("🎨 <b>Image AI</b>\nChoose an action:", { parse_mode: "HTML", reply_markup: keyboard });
    return true;
  }

  if (text === normalizeControlText(CONTROL_TEXT.pause)) {
    resetImageInteraction();
    logger.info(`[Bot] Control button received: Pause chatId=${ctx.chat.id}`);
    await pauseCurrentChat(ctx);
    return true;
  }

  if (text === normalizeControlText(CONTROL_TEXT.resume)) {
    resetImageInteraction();
    logger.info(`[Bot] Control button received: Resume chatId=${ctx.chat.id}`);
    if (botInstance && currentEnsureEventSubscription) {
      await resumePausedChat(ctx, { bot: botInstance, ensureEventSubscription: currentEnsureEventSubscription });
    }
    return true;
  }

  if (text === normalizeControlText(CONTROL_TEXT.abort)) {
    resetImageInteraction();
    logger.info(`[Bot] Control button received: Abort chatId=${ctx.chat.id}`);
    await abortCurrentOperation(ctx);
    return true;
  }

  if (text === normalizeControlText(CONTROL_TEXT.cancel)) {
    resetImageInteraction();
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
  }

  return false;
}

function installTextRouting(bot: Bot<Context>, deps: MessageRouterDeps): void {
  bot.on("message:text", async (ctx, next) => {
    const rawText = ctx.message.text;
    const text = rawText.trim();
    if (!text) return;

    deps.setTelegramContext(bot, ctx.chat.id);
    agentArtifactDeliveryService.setChatId(ctx.chat.id);

    logger.debug(`[Bot] Received text message: ${text.startsWith("/") ? `command=\"${text}\"` : `prompt (length=${text.length})`}, chatId=${ctx.chat.id}`);

    if (await handlePriorityControlButton(ctx)) return;

    if (text.startsWith("/")) {
      if (!/^\/(?:image|edit)(?:@\w+)?(?:\s|$)/u.test(text)) resetImageInteraction();
      await next();
      return;
    }

    // Reply-keyboard presses arrive from Telegram as normal text messages.
    // Dynamic model labels are recognized only by exact current-label matching;
    // this prevents ordinary prompts such as "🧠 Explain this architecture 2026" from being controls.
    const knownReplyKeyboardButtonTexts = new Set<string>([getCurrentModelButtonText()]);
    if (isReplyKeyboardButtonText(text, knownReplyKeyboardButtonTexts)) {
      if (text !== MAIN_BUTTONS.imageAi) resetImageInteraction();
      await next();
      return;
    }

    if (await handleProviderWizardMessage(ctx)) return;
    if (await handleIntegrationMessage(ctx)) return;
    if (questionManager.isActive()) {
      await handleQuestionTextAnswer(ctx);
      return;
    }
    if (await handleImageModeText(ctx, text)) return;
    if (await handleTaskTextInput(ctx)) return;
    if (await handleModelSearchTextInput(ctx)) return;
    if (await handleRenameTextAnswer(ctx)) return;

    const promptDeps = { bot, ensureEventSubscription: deps.ensureEventSubscription };
    if (await handleCatalogTextArguments(ctx, promptDeps)) return;

    queuePromptForMerging(ctx, text, promptDeps, config.bot.messageMergeWindowMs);
  });
}

export function registerMessageRouter(bot: Bot<Context>, deps: MessageRouterDeps): void {
  botInstance = bot;
  currentEnsureEventSubscription = deps.ensureEventSubscription;

  bot.on("message", async (ctx, next) => {
    if (ctx.chat?.id) {
      agentArtifactDeliveryService.setChatId(ctx.chat.id);
      deps.setTelegramContext(bot, ctx.chat.id);
    }
    await next();
  });

  installTextRouting(bot, deps);
  bot.on("message:text", unknownCommandMiddleware);

  bot.hears(/^❌ Cancel$/, async (ctx) => {
    resetImageInteraction();
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
    resetImageInteraction();
    if (await blockMenuWhileInteractionActive(ctx)) return;
    await settingsCommand(ctx as never);
  });

  bot.hears(/^🕘 History$/, async (ctx) => {
    resetImageInteraction();
    if (await blockMenuWhileInteractionActive(ctx)) return;
    await sessionsCommand(ctx as never);
  });

  bot.hears(/^💬 New Chat$/, async (ctx) => {
    resetImageInteraction();
    if (await blockMenuWhileInteractionActive(ctx)) return;
    await newCommand(ctx as never, { bot, ensureEventSubscription: deps.ensureEventSubscription });
  });

  bot.hears(/^📦 Compact: (?:ON|OFF)$/, handleCompactModeButton);

  bot.hears(QUEUED_PROMPT_BUTTON_TEXT_PATTERN, async (ctx) => {
    resetImageInteraction();
    if (await blockMenuWhileInteractionActive(ctx)) return;

    const label = ctx.message?.text;
    const queuedPrompt = label ? findQueuedPromptByButtonLabel(label) : null;
    const keyboard = keyboardManager.getKeyboard();
    if (queuedPrompt) {
      promptQueue.removeById(queuedPrompt.id);
      await ctx.reply(t("queue.removed"), keyboard ? { reply_markup: keyboard } : {});
      return;
    }
    await ctx.reply(t("queue.not_found"), keyboard ? { reply_markup: keyboard } : {});
  });

  bot.hears(AGENT_MODE_BUTTON_TEXT_PATTERN, async (ctx) => {
    try {
      resetImageInteraction();
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
      resetImageInteraction();
      if (await blockMenuWhileInteractionActive(ctx)) return;
      await showModelCenterMenu(ctx);
    } catch (err) {
      logger.error("[Bot] Error showing model center:", err);
      await ctx.reply(t("error.load_models"));
    }
  });

  bot.hears(CONTEXT_BUTTON_TEXT_PATTERN, async (ctx) => {
    try {
      resetImageInteraction();
      if (await blockMenuWhileInteractionActive(ctx)) return;
      await handleContextButtonPress(ctx);
    } catch (err) {
      logger.error("[Bot] Error handling context button:", err);
      await ctx.reply(t("error.context_button"));
    }
  });

  bot.hears(VARIANT_BUTTON_TEXT_PATTERN, async (ctx) => {
    try {
      resetImageInteraction();
      if (await blockMenuWhileInteractionActive(ctx)) return;
      await showVariantSelectionMenu(ctx);
    } catch (err) {
      logger.error("[Bot] Error showing variants menu:", err);
      await ctx.reply(t("error.load_variants"));
    }
  });

  const voicePromptDeps = { bot, ensureEventSubscription: deps.ensureEventSubscription };
  bot.on("message:voice", async (ctx) => {
    deps.setTelegramContext(bot, ctx.chat.id);
    agentArtifactDeliveryService.setChatId(ctx.chat.id);
    await handleVoiceMessage(ctx, voicePromptDeps);
  });

  bot.on("message:audio", async (ctx) => {
    deps.setTelegramContext(bot, ctx.chat.id);
    agentArtifactDeliveryService.setChatId(ctx.chat.id);
    await handleVoiceMessage(ctx, voicePromptDeps);
  });

  bot.on("message", createMediaGroupAttachmentMiddleware({ bot, ensureEventSubscription: deps.ensureEventSubscription }));

  bot.on("message:photo", async (ctx) => {
    deps.setTelegramContext(bot, ctx.chat.id);
    agentArtifactDeliveryService.setChatId(ctx.chat.id);

    const caption = ctx.message.caption?.trim() ?? "";
    if (/^\/edit(?:@\w+)?(?:\s|$)/u.test(caption)) {
      resetImageInteraction();
      await editPhotoMessage(ctx, caption.replace(/^\/edit(?:@\w+)?\s*/u, "").trim());
      return;
    }

    const mode = getImageMode();
    if (mode === "generate") {
      resetImageInteraction();
      await ctx.reply("🖼️ Generate mode is active. Send a text or voice prompt to create a new image.");
      return;
    }

    if (mode === "edit") {
      const source = await downloadPhoto(ctx);
      rememberPendingImage({ ...source, expiresAt: Date.now() + PENDING_IMAGE_TTL_MS });
      if (caption) {
        await handleImageModeText(ctx, caption);
      } else {
        await ctx.reply("🖼️ Photo received. Now send the edit instruction as text or voice.");
      }
      return;
    }

    await handlePhotoMessage(ctx, { bot, ensureEventSubscription: deps.ensureEventSubscription });
  });

  bot.on("message:document", async (ctx) => {
    deps.setTelegramContext(bot, ctx.chat.id);
    agentArtifactDeliveryService.setChatId(ctx.chat.id);
    await handleDocumentMessage(ctx, { bot, ensureEventSubscription: deps.ensureEventSubscription });
  });
}
