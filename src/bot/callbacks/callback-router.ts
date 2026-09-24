import type { Bot, Context } from "grammy";
import { clearInteractionErrorState, interactionManager, type InteractionErrorScope } from "../../app/managers/interaction-manager.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { handleAgentSelect } from "./agent-selection-callback-handler.js";
import { handleCommandsCallback } from "./command-catalog-callback-handler.js";
import { handleCompactConfirm } from "./context-control-callback-handler.js";
import { handleLsCallback, handleOpenCallback } from "./file-browser-callback-handler.js";
import { handleInlineMenuCancel } from "./inline-menu-cancel-callback-handler.js";
import { handleMcpsCallback } from "./mcp-server-callback-handler.js";
import { handleMessagesCallback } from "./message-history-callback-handler.js";
import { handleModelCenterCallback } from "./model-center-callback-handler.js";
import { handlePermissionCallback } from "./permission-callback-handler.js";
import { handlePromptAttachmentCancel } from "./prompt-attachment-callback-handler.js";
import { handleQuestionCallback } from "./question-callback-handler.js";
import { handleRenameCancel } from "./rename-callback-handler.js";
import { handleSettingsCallback } from "./settings-callback-handler.js";
import { clearProviderWizard, handleProviderCallback } from "../commands/providers-command.js";
import {
  clearMcpAddWizard,
  clearMcpAuthWizard,
  clearMcpCredentialWizard,
} from "../commands/mcp-server-command.js";
import { clearIntegrationWizard, handleIntegrationsCallback } from "../commands/integrations-command.js";
import { clearSkillWizard } from "../commands/skills-wizard.js";
import { clearSkillImportFlow } from "../commands/skills-import-flow.js";
import { commandsCommand } from "../commands/command-catalog-command.js";
import { skillsCommand } from "../commands/skills-catalog-command.js";
import { handleBackgroundSessionOpen, handleSessionSelect } from "./session-callback-handler.js";
import { handleSessionPreviewCallback } from "./session-preview-callback-handler.js";
import { handleSkillsCallback } from "./skills-catalog-callback-handler.js";
import { handleTaskCallback, handleTaskListCallback } from "./scheduled-task-callback-handler.js";
import { handleVariantSelect } from "./variant-selection-callback-handler.js";
import { handleWorktreeCallback } from "./worktree-callback-handler.js";
import { clearLsPathIndex, clearOpenPathIndex } from "../menus/file-browser-menu.js";
import { buildAdvancedSettingsView, buildSettingsMenuView } from "../menus/settings-menu.js";
import { clearActiveInlineMenu, replyWithInlineMenu } from "../menus/inline-menu.js";
import { MODEL_CENTER_SETTINGS_BACK } from "../menus/model-center-menu.js";
import { markGeminiWizard, clearGeminiWizard } from "../services/gemini-wizard-state.js";
import { getCurrentSession, setCurrentSession } from "../../app/services/session-service.js";
import { findTelegramTopicBindingByThread } from "../../app/services/telegram-topic-store.js";
import { handleTelegramTopicDeleteCallback, registerTelegramTopicDeleteHandlers } from "../services/telegram-topic-delete-handler.js";
import { sessionsCommand } from "../commands/sessions-command.js";
import { newCommand } from "../commands/new-command.js";
import { settingsCommand } from "../commands/settings-command.js";
import { showModelCenterMenu } from "../menus/model-center-menu.js";
import { createMainInlineKeyboard } from "../keyboards/main-reply-keyboard.js";
import { buildMainStatusText, keyboardManager } from "../keyboards/keyboard-manager.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { getMainNavigationMessageId } from "../../app/stores/settings-store.js";

type CallbackHandler = (ctx: Context) => Promise<boolean>;
interface CallbackRoute { name: string; handlers: CallbackHandler[]; errorScope: InteractionErrorScope; }
interface CallbackRouterDeps { ensureEventSubscription: (directory: string) => Promise<void>; setTelegramContext: (bot: Bot<Context>, chatId: number, sessionId?: string) => void; }
function parseCallbackPrefix(data: string): string | null { const separatorIndex = data.indexOf(":"); return separatorIndex <= 0 ? null : data.slice(0, separatorIndex); }

function clearGeneralPanelWizardState(reason: string): void {
  clearProviderWizard();
  clearIntegrationWizard();
  clearMcpAddWizard();
  clearMcpAuthWizard();
  clearMcpCredentialWizard();
  clearSkillWizard();
  clearSkillImportFlow();
  const state = interactionManager.getSnapshot();
  if (state?.kind === "custom") interactionManager.clear(reason);
}

async function resolveCallbackTopicSession(ctx: Context): Promise<string | null> {
  const callbackMessage = ctx.callbackQuery?.message;
  if (!callbackMessage || callbackMessage.chat.type !== "private") return null;
  const threadId = "message_thread_id" in callbackMessage ? callbackMessage.message_thread_id : undefined;
  if (typeof threadId !== "number" || threadId <= 1) return null;
  const binding = await findTelegramTopicBindingByThread(callbackMessage.chat.id, threadId);
  if (!binding) return null;
  const current = getCurrentSession();
  if (current?.id !== binding.sessionId || current.directory !== binding.directory) {
    setCurrentSession({ id: binding.sessionId, title: binding.title || `Session ${binding.sessionId.slice(0, 8)}`, directory: binding.directory });
  }
  logger.debug(`[TopicNavigation] Resolved callback by bound thread: chat=${callbackMessage.chat.id}, thread=${threadId}, session=${binding.sessionId}`);
  return binding.sessionId;
}

async function handleMainNavigationCallback(ctx: Context, data: string, bot: Bot<Context>, deps: CallbackRouterDeps): Promise<boolean> {
  if (!data.startsWith("main:")) return false;
  const callbackMessage = ctx.callbackQuery?.message;
  const threadId = callbackMessage && "message_thread_id" in callbackMessage ? callbackMessage.message_thread_id : undefined;

  if (data === "main:home") {
    clearGeneralPanelWizardState("main_home");
    const chatId = ctx.chat?.id ?? callbackMessage?.chat.id;
    const messageId = callbackMessage && "message_id" in callbackMessage ? callbackMessage.message_id : undefined;
    if (typeof chatId !== "number" || typeof messageId !== "number") return true;
    await ctx.answerCallbackQuery().catch(() => {});
    try {
      const canonicalMessageId = getMainNavigationMessageId(chatId);
      if (canonicalMessageId === messageId) {
        const currentModel = getStoredModel();
        const text = await buildMainStatusText(currentModel);
        await ctx.api.editMessageText(chatId, canonicalMessageId, text, { parse_mode: "HTML", reply_markup: createMainInlineKeyboard(currentModel) });
        await keyboardManager.pinMainInlineMessage(chatId, canonicalMessageId);
        clearActiveInlineMenu("inline_menu_home", chatId, typeof threadId === "number" ? threadId : undefined);
        logger.info(`[Navigation] Restored canonical Main anchor in-place from Home: chat=${chatId}, message=${canonicalMessageId}, sourceThread=${typeof threadId === "number" ? threadId : "General/native-default"}`);
      } else {
        await keyboardManager.sendMainInlineKeyboard(chatId, undefined, true);
        if (messageId !== canonicalMessageId) await ctx.api.deleteMessage(chatId, messageId).catch(() => {});
        clearActiveInlineMenu("inline_menu_home_restore", chatId, typeof threadId === "number" ? threadId : undefined);
        logger.info(`[Navigation] Restored canonical Main anchor from Home: chat=${chatId}, childMessage=${messageId}, previousCanonical=${canonicalMessageId ?? "none"}`);
      }
    } catch (error) { logger.warn(`[Navigation] Failed to restore canonical Main from Home: chat=${chatId}, message=${messageId}`, error); }
    return true;
  }

  if (typeof threadId === "number" && threadId > 1) {
    await ctx.answerCallbackQuery({ text: "Use General for main navigation." }).catch(() => {});
    return true;
  }
  await ctx.answerCallbackQuery().catch(() => {});
  if (data === "main:history") { clearGeneralPanelWizardState("main_history"); await sessionsCommand(ctx as never); return true; }
  if (data === "main:new") { clearGeneralPanelWizardState("main_new"); await newCommand(ctx as never, { bot, ensureEventSubscription: deps.ensureEventSubscription }); return true; }
  if (data === "main:model") { clearGeneralPanelWizardState("main_model"); await showModelCenterMenu(ctx); return true; }
  if (data === "main:settings") { clearGeneralPanelWizardState("main_settings"); await settingsCommand(ctx as never); return true; }
  await ctx.answerCallbackQuery({ text: t("callback.unknown_command") }).catch(() => {});
  return true;
}

async function handleSettingsChildNavigation(ctx: Context, data: string): Promise<boolean> {
  const isAdvancedBack = data === "commands:back" || data === "skills:back" || data === "mcps:parent_back" || data === "integration:advanced";
  if (isAdvancedBack) {
    clearGeneralPanelWizardState(`advanced_back:${data}`);
    await ctx.answerCallbackQuery().catch(() => {});
    const view = buildAdvancedSettingsView();
    await replyWithInlineMenu(ctx, { menuKind: "settings", text: view.text, keyboard: view.keyboard });
    logger.debug(`[Navigation] Restored Advanced settings from child menu: ${data}`);
    return true;
  }
  if (data === MODEL_CENTER_SETTINGS_BACK) {
    clearGeneralPanelWizardState("model_center_settings_back");
    await ctx.answerCallbackQuery().catch(() => {});
    const view = buildSettingsMenuView();
    await replyWithInlineMenu(ctx, { menuKind: "settings", text: view.text, keyboard: view.keyboard });
    logger.debug("[Navigation] Restored Settings from Model Center");
    return true;
  }
  return false;
}

async function handleCatalogListBack(ctx: Context, data: string): Promise<boolean> {
  if (data !== "commands:list_back" && data !== "skills:list_back") return false;
  clearGeneralPanelWizardState(`catalog_back:${data}`);
  await ctx.answerCallbackQuery().catch(() => {});
  if (data === "commands:list_back") await commandsCommand(ctx as never);
  else await skillsCommand(ctx as never);
  logger.debug(`[Navigation] Returned from catalog confirm screen: ${data}`);
  return true;
}

export function registerCallbackRouter(bot: Bot<Context>, deps: CallbackRouterDeps): void {
  registerTelegramTopicDeleteHandlers(bot);
  const routes = new Map<string, CallbackRoute>([
    ["agent", { name: "agent", handlers: [handleAgentSelect], errorScope: "interaction" }],
    ["attach", { name: "attach", handlers: [handlePromptAttachmentCancel], errorScope: "interaction" }],
    ["commands", { name: "commands", handlers: [(ctx) => handleCommandsCallback(ctx, { bot, ensureEventSubscription: deps.ensureEventSubscription })], errorScope: "interaction" }],
    ["compact", { name: "compact", handlers: [handleCompactConfirm], errorScope: "interaction" }],
    ["ls", { name: "ls", handlers: [handleLsCallback], errorScope: "interaction" }],
    ["mcps", { name: "mcps", handlers: [handleMcpsCallback], errorScope: "interaction" }],
    ["messages", { name: "messages", handlers: [(ctx) => handleMessagesCallback(ctx, { bot, ensureEventSubscription: deps.ensureEventSubscription })], errorScope: "interaction" }],
    ["mc", { name: "mc", handlers: [handleModelCenterCallback], errorScope: "interaction" }],
    ["open", { name: "open", handlers: [(ctx) => handleOpenCallback(ctx, { ensureEventSubscription: deps.ensureEventSubscription })], errorScope: "interaction" }],
    ["permission", { name: "permission", handlers: [handlePermissionCallback], errorScope: "permission" }],
    ["question", { name: "question", handlers: [handleQuestionCallback], errorScope: "question" }],
    ["rename", { name: "rename", handlers: [handleRenameCancel], errorScope: "rename" }],
    ["session", { name: "session", handlers: [
      (ctx) => handleSessionPreviewCallback(ctx, { bot, ensureEventSubscription: deps.ensureEventSubscription }),
      (ctx) => handleSessionSelect(ctx, { bot, ensureEventSubscription: deps.ensureEventSubscription }),
    ], errorScope: "interaction" }],
    ["settings", { name: "settings", handlers: [handleSettingsCallback], errorScope: "none" }],
    ["skills", { name: "skills", handlers: [(ctx) => handleSkillsCallback(ctx, { bot, ensureEventSubscription: deps.ensureEventSubscription })], errorScope: "interaction" }],
    ["task", { name: "task", handlers: [handleTaskCallback], errorScope: "taskCreation" }],
    ["tasklist", { name: "tasklist", handlers: [handleTaskListCallback], errorScope: "interaction" }],
    ["variant", { name: "variant", handlers: [handleVariantSelect], errorScope: "interaction" }],
    ["worktree", { name: "worktree", handlers: [(ctx) => handleWorktreeCallback(ctx, { ensureEventSubscription: deps.ensureEventSubscription })], errorScope: "interaction" }],
    ["provider", { name: "provider", handlers: [handleProviderCallback], errorScope: "interaction" }],
    ["integration", { name: "integration", handlers: [handleIntegrationsCallback], errorScope: "interaction" }],
  ]);

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery?.data ?? "";
    let topicSessionId: string | null = null;
    let errorScope: InteractionErrorScope = "interaction";
    try {
      clearProviderWizard();
      topicSessionId = await resolveCallbackTopicSession(ctx);
      if (ctx.chat) deps.setTelegramContext(bot, ctx.chat.id, topicSessionId ?? getCurrentSession()?.id);
      if (data === "provider:gemini:configure") markGeminiWizard();
      if (data === "provider:cancel" || data === "provider:menu" || data === "provider:close") clearGeminiWizard();
      if (await handleMainNavigationCallback(ctx, data, bot, deps)) return;
      if (await handleTelegramTopicDeleteCallback(ctx)) return;
      if (await handleBackgroundSessionOpen(ctx, { bot, ensureEventSubscription: deps.ensureEventSubscription })) return;
      if (await handleInlineMenuCancel(ctx)) { clearOpenPathIndex(); clearLsPathIndex(); return; }
      if (await handleSettingsChildNavigation(ctx, data)) return;
      if (await handleCatalogListBack(ctx, data)) return;
      const prefix = parseCallbackPrefix(data);
      const route = prefix ? routes.get(prefix) : undefined;
      if (!route) { await ctx.answerCallbackQuery({ text: t("callback.unknown_command") }); return; }
      errorScope = route.errorScope;
      for (const handler of route.handlers) if (await handler(ctx)) return;
      await ctx.answerCallbackQuery({ text: t("callback.unknown_command") });
    } catch (err) {
      logger.error("[Bot] Error handling callback:", err);
      clearInteractionErrorState(errorScope, "callback_handler_error");
      clearGeminiWizard();
      await ctx.answerCallbackQuery({ text: t("callback.processing_error") }).catch(() => {});
    }
  });
}