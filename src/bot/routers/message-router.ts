import type { Bot, Context } from "grammy";
import { InputFile } from "grammy";
import { config } from "../../config.js";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import { questionManager } from "../../app/managers/question-manager.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { handleTaskTextInput } from "../commands/task-command.js";
import { handleProviderWizardMessage, isProviderWizardActive, clearProviderWizard, providersCommand } from "../commands/providers-command.js";
import { handleIntegrationMessage, isIntegrationWizardActive, clearIntegrationWizard, integrationsCommand } from "../commands/integrations-command.js";
import { handleModelSearchTextInput } from "../callbacks/model-selection-callback-handler.js";
import { handleQuestionTextAnswer } from "../callbacks/question-callback-handler.js";
import { handleRenameTextAnswer } from "../callbacks/rename-callback-handler.js";
import { handleContextButtonPress } from "../menus/context-control-menu.js";
import { showAgentSelectionMenu } from "../menus/agent-selection-menu.js";
import { showAiRulesMenu } from "../callbacks/ai-role-selection-callback-handler.js";
import { showVariantSelectionMenu } from "../menus/variant-selection-menu.js";
import { AGENT_MODE_BUTTON_TEXT_PATTERN, CONTEXT_BUTTON_TEXT_PATTERN, MODEL_BUTTON_TEXT_PATTERN, QUEUED_PROMPT_BUTTON_TEXT_PATTERN, VARIANT_BUTTON_TEXT_PATTERN } from "../message-patterns.js";
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
let pendingImage: PendingImage | null = null;
const IMAGE_EDIT_INTENT_PATTERN = /\b(?:edit|change|modify|remove|replace|add|delete|background|backdrop|style|transform|enhance|upscale|crop|resize|retouch|make|turn|generate|دستکاری|ویرایش|تغییر|حذف|اضافه|پس.?زمینه|بک.?گراند|کیفیت|بزرگ|کوچک|تبدیل|بساز|درست)\b/iu;
const CONTROL_TEXT = { cancel: "❌ Cancel", pause: MAIN_BUTTONS.pause, abort: MAIN_BUTTONS.abort, resume: MAIN_BUTTONS.resume } as const;
const REPLY_KEYBOARD_TEXT: ReadonlySet<string> = new Set([CONTROL_TEXT.cancel, CONTROL_TEXT.pause, CONTROL_TEXT.resume, CONTROL_TEXT.abort, MAIN_BUTTONS.history, MAIN_BUTTONS.newChat, MAIN_BUTTONS.aiRules, MAIN_BUTTONS.settings, MAIN_BUTTONS.editImage]);
function normalizeControlText(text: string): string { return text.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\uFE0F/g, "").replace(/\s+/g, " ").trim(); }
function isImageEditIntent(text: string): boolean { return IMAGE_EDIT_INTENT_PATTERN.test(text); }
function rememberPendingImage(image: PendingImage): void {
  pendingImage = image;
  setTimeout(() => {
    if (pendingImage === image) pendingImage = null;
  }, PENDING_IMAGE_TTL_MS).unref?.();
}
async function handlePendingImageEdit(ctx: Context, text: string): Promise<boolean> {
  if (!ctx.chat || !isImageEditIntent(text)) return false;
  if (!pendingImage || pendingImage.expiresAt <= Date.now()) {
    pendingImage = null;
    return false;
  }
  const image = pendingImage;
  pendingImage = null;
  if (!(await isMediaAiConfigured())) {
    await ctx.reply("🎨 Image AI is not configured. Open /providers and add the image provider.");
    return true;
  }
  try {
    await ctx.replyWithChatAction("upload_photo");
    const result = await editImage(image.buffer, image.mimeType, text);
    await ctx.replyWithPhoto(new InputFile(result.buffer, `edited.${result.mimeType.split("/")[1] ?? "png"}`), { caption: "✨ Edited with Image AI" });
  } catch (error) {
    await ctx.reply(`❌ Image editing failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return true;
}
let botInstance: Bot<Context> | null = null;
let currentEnsureEventSubscription: ((directory: string) => Promise<void>) | null = null;
async function handlePriorityControlButton(ctx: Context): Promise<boolean> { const rawText = ctx.message?.text; const chatId = ctx.chat?.id; if (!rawText || !chatId) return false; const text = normalizeControlText(rawText); if (text === normalizeControlText(CONTROL_TEXT.pause)) { logger.info(`[Bot] Control button received: Pause chatId=${chatId}`); await pauseCurrentChat(ctx); return true; } if (text === normalizeControlText(CONTROL_TEXT.resume)) { logger.info(`[Bot] Control button received: Resume chatId=${chatId}`); if (botInstance && currentEnsureEventSubscription) await resumePausedChat(ctx, { bot: botInstance, ensureEventSubscription: currentEnsureEventSubscription }); return true; } if (text === normalizeControlText(CONTROL_TEXT.abort)) { logger.info(`[Bot] Control button received: Abort chatId=${chatId}`); await abortCurrentOperation(ctx); return true; } if (text === normalizeControlText(CONTROL_TEXT.cancel)) { logger.info(`[Bot] Control button received: Cancel chatId=${chatId}`); if (isProviderWizardActive(chatId)) { clearProviderWizard(chatId); clearIntegrationWizard(chatId); await providersCommand(ctx as never); return true; } if (isIntegrationWizardActive(chatId)) { clearIntegrationWizard(chatId); clearProviderWizard(chatId); await integrationsCommand(ctx as never); return true; } } if (text === normalizeControlText(MAIN_BUTTONS.editImage)) { await ctx.reply("🎨 Send the photo you want to edit, then describe the change in your next message. You can also put the instruction directly in the photo caption."); return true; } if (text === normalizeControlText(MAIN_BUTTONS.aiRules)) { if (await blockMenuWhileInteractionActive(ctx)) return true; await showAiRulesMenu(ctx); return true; } return false; }
async function blockMenuWhileInteractionActive(ctx: Context): Promise<boolean> { if (assistantRunState.hasActiveRuns()) return true; const activeInteraction = interactionManager.getSnapshot(); if (!activeInteraction) return false; if (activeInteraction.kind === "inline") { await closeActiveInlineMenu(ctx, "reply-keyboard-navigation"); return false; } logger.debug(`[Bot] Blocking menu open while interaction active: kind=${activeInteraction.kind}, expectedInput=${activeInteraction.expectedInput}`); await ctx.reply(t("interaction.blocked.finish_current")); return true; }
async function handleCompactModeButton(ctx: Context): Promise<boolean> { if (ctx.message?.text !== MAIN_BUTTONS.compact(getCompactOutputMode())) return false; if (await blockMenuWhileInteractionActive(ctx)) return true; const enabled = !getCompactOutputMode(); setCompactOutputMode(enabled); const keyboard = keyboardManager.getKeyboard(); await ctx.reply(`📦 Compact Mode: ${enabled ? "ON" : "OFF"}`, keyboard ? { reply_markup: keyboard } : {}); return true; }
export function registerMessageRouter(bot: Bot<Context>, deps: MessageRouterDeps): void {
  botInstance = bot; currentEnsureEventSubscription = deps.ensureEventSubscription;
  bot.on("message", async (ctx, next) => { if (ctx.chat?.id) { agentArtifactDeliveryService.setChatId(ctx.chat.id); deps.setTelegramContext(bot, ctx.chat.id); } await next(); });
  bot.on("message:text", async (ctx, next) => { if (await handlePriorityControlButton(ctx)) return; await next(); });
  bot.on("message:text", unknownCommandMiddleware);
  bot.hears(/^❌ Cancel$/, async (ctx) => { const chatId = ctx.chat.id; if (isProviderWizardActive(chatId)) { clearProviderWizard(chatId); clearIntegrationWizard(chatId); await providersCommand(ctx as never); return; } if (isIntegrationWizardActive(chatId)) { clearIntegrationWizard(chatId); clearProviderWizard(chatId); await integrationsCommand(ctx as never); return; } });
  bot.hears(/^⚙️ Settings$/, async (ctx) => { if (await blockMenuWhileInteractionActive(ctx)) return; await settingsCommand(ctx as never); });
  bot.hears(/^🕘 History$/, async (ctx) => { if (await blockMenuWhileInteractionActive(ctx)) return; await sessionsCommand(ctx as never); });
  bot.hears(/^💬 New Chat$/, async (ctx) => { if (await blockMenuWhileInteractionActive(ctx)) return; await newCommand(ctx as never, { bot, ensureEventSubscription: deps.ensureEventSubscription }); });
  bot.hears(/^📦 Compact: (?:ON|OFF)$/, handleCompactModeButton);
  bot.hears(QUEUED_PROMPT_BUTTON_TEXT_PATTERN, async (ctx) => { if (await blockMenuWhileInteractionActive(ctx)) return; const label = ctx.message?.text; const queuedPrompt = label ? findQueuedPromptByButtonLabel(label) : null; const keyboard = keyboardManager.getKeyboard(); if (queuedPrompt) { promptQueue.removeById(queuedPrompt.id); await ctx.reply(t("queue.removed"), keyboard ? { reply_markup: keyboard } : {}); return; } await ctx.reply(t("queue.not_found"), keyboard ? { reply_markup: keyboard } : {}); });
  bot.hears(AGENT_MODE_BUTTON_TEXT_PATTERN, async (ctx) => { try { if (await blockMenuWhileInteractionActive(ctx)) return; await showAgentSelectionMenu(ctx); } catch (err) { logger.error("[Bot] Error showing agent menu:", err); await ctx.reply(t("error.load_agents")); } });
  bot.hears(MODEL_BUTTON_TEXT_PATTERN, async (ctx) => { try { if (await blockMenuWhileInteractionActive(ctx)) return; await showAiRulesMenu(ctx); } catch (err) { logger.error("[Bot] Error showing models menu:", err); await ctx.reply(t("error.load_models")); } });
  bot.hears(CONTEXT_BUTTON_TEXT_PATTERN, async (ctx) => { try { if (await blockMenuWhileInteractionActive(ctx)) return; await handleContextButtonPress(ctx); } catch (err) { logger.error("[Bot] Error handling context button:", err); await ctx.reply(t("error.context_button")); } });
  bot.hears(VARIANT_BUTTON_TEXT_PATTERN, async (ctx) => { try { if (await blockMenuWhileInteractionActive(ctx)) return; await showVariantSelectionMenu(ctx); } catch (err) { logger.error("[Bot] Error showing variant menu:", err); await ctx.reply(t("error.load_variants")); } });
  bot.on("message:text", async (ctx, next) => { const text = ctx.message?.text; if (text) logger.debug(`[Bot] Received text message: ${text.startsWith("/") ? `command=\"${text}\"` : `prompt (length=${text.length})`}, chatId=${ctx.chat.id}`); await next(); });
  const voicePromptDeps = { bot, ensureEventSubscription: deps.ensureEventSubscription };
  bot.on("message:voice", async (ctx) => { deps.setTelegramContext(bot, ctx.chat.id); agentArtifactDeliveryService.setChatId(ctx.chat.id); await handleVoiceMessage(ctx, voicePromptDeps); });
  bot.on("message:audio", async (ctx) => { deps.setTelegramContext(bot, ctx.chat.id); agentArtifactDeliveryService.setChatId(ctx.chat.id); await handleVoiceMessage(ctx, voicePromptDeps); });
  bot.on("message", createMediaGroupAttachmentMiddleware({ bot, ensureEventSubscription: deps.ensureEventSubscription }));
  bot.on("message:photo", async (ctx) => { deps.setTelegramContext(bot, ctx.chat.id); agentArtifactDeliveryService.setChatId(ctx.chat.id); const caption = ctx.message.caption?.trim() ?? ""; if (/^\/edit(?:@\w+)?(?:\s|$)/u.test(caption)) { await editPhotoMessage(ctx, caption.replace(/^\/edit(?:@\w+)?\s*/u, "").trim()); return; } const source = await downloadPhoto(ctx); rememberPendingImage({ ...source, expiresAt: Date.now() + PENDING_IMAGE_TTL_MS }); if (caption && isImageEditIntent(caption)) { await editPhotoMessage(ctx, caption); pendingImage = null; return; } await handlePhotoMessage(ctx, { bot, ensureEventSubscription: deps.ensureEventSubscription }); });
  bot.on("message:document", async (ctx) => { deps.setTelegramContext(bot, ctx.chat.id); agentArtifactDeliveryService.setChatId(ctx.chat.id); await handleDocumentMessage(ctx, { bot, ensureEventSubscription: deps.ensureEventSubscription }); });
  bot.on("message:text", async (ctx) => {
    const text = ctx.message?.text?.trim();
    if (!text) return;
    deps.setTelegramContext(bot, ctx.chat.id);
    agentArtifactDeliveryService.setChatId(ctx.chat.id);
    if (text.startsWith("/")) return;
    if (REPLY_KEYBOARD_TEXT.has(text) || /^📦 Compact: (?:ON|OFF)$/.test(text)) return;
    if (await handleProviderWizardMessage(ctx)) return;
    if (await handleIntegrationMessage(ctx)) return;
    if (questionManager.isActive()) { await handleQuestionTextAnswer(ctx); return; }
    if (await handlePendingImageEdit(ctx, text)) return;
    if (await handleTaskTextInput(ctx)) return;
    if (await handleModelSearchTextInput(ctx)) return;
    if (await handleRenameTextAnswer(ctx)) return;
    if (await handleImageTextPrompt(ctx, text)) return;
    const promptDeps = { bot, ensureEventSubscription: deps.ensureEventSubscription };
    if (await handleCatalogTextArguments(ctx, promptDeps)) return;
    queuePromptForMerging(ctx, text, promptDeps, config.bot.messageMergeWindowMs);
  });
}
