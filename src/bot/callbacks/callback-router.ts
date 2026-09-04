import type { Bot, Context } from "grammy";
import { clearInteractionErrorState, type InteractionErrorScope } from "../../app/managers/interaction-manager.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { handleAgentSelect } from "./agent-selection-callback-handler.js";
import { handleCommandsCallback } from "./command-catalog-callback-handler.js";
import { handleCompactConfirm } from "./context-control-callback-handler.js";
import { handleLsCallback, handleOpenCallback } from "./file-browser-callback-handler.js";
import { handleInlineMenuCancel } from "./inline-menu-cancel-callback-handler.js";
import { handleMcpsCallback } from "./mcp-catalog-callback-handler.js";
import { handleMessagesCallback } from "./message-history-callback-handler.js";
import { handleModelCenterCallback } from "./model-center-callback-handler.js";
import { handleModelProvidersCallback, handleModelSearchCallback, handleModelSearchResults, handleModelSelect } from "./model-selection-callback-handler.js";
import { handleAiRoleCallback } from "./ai-role-selection-callback-handler.js";
import { handlePermissionCallback } from "./permission-callback-handler.js";
import { handlePromptAttachmentCancel } from "./prompt-attachment-callback-handler.js";
import { handleQuestionCallback } from "./question-callback-handler.js";
import { handleRenameCancel } from "./rename-callback-handler.js";
import { handleSettingsCallback } from "./settings-callback-handler.js";
import { handleProviderCallback } from "../commands/providers-command.js";
import { handleIntegrationsCallback } from "../commands/integrations-command.js";
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
import { replyWithInlineMenu } from "../menus/inline-menu.js";
import { MODEL_SETTINGS_BACK_CALLBACK } from "../menus/model-selection-menu.js";
import { markGeminiWizard, clearGeminiWizard } from "../services/gemini-wizard-state.js";
import { activateImageMode } from "../../app/services/image-mode-service.js";

type CallbackHandler = (ctx: Context) => Promise<boolean>;
interface CallbackRoute { name: string; handlers: CallbackHandler[]; errorScope: InteractionErrorScope; }
interface CallbackRouterDeps { ensureEventSubscription: (directory: string) => Promise<void>; setTelegramContext: (bot: Bot<Context>, chatId: number) => void; }
function parseCallbackPrefix(data: string): string | null { const separatorIndex = data.indexOf(":"); return separatorIndex <= 0 ? null : data.slice(0, separatorIndex); }
async function handleSettingsChildNavigation(ctx: Context, data: string): Promise<boolean> { const isAdvancedBack = data === "commands:back" || data === "skills:back" || data === "mcps:parent_back" || data === "provider:advanced" || data === "integration:advanced"; if (isAdvancedBack) { await ctx.answerCallbackQuery().catch(() => {}); const view = buildAdvancedSettingsView(); await replyWithInlineMenu(ctx, { menuKind: "settings", text: view.text, keyboard: view.keyboard }); logger.debug(`[Navigation] Restored Advanced settings from child menu: ${data}`); return true; } if (data === MODEL_SETTINGS_BACK_CALLBACK) { await ctx.answerCallbackQuery().catch(() => {}); const view = buildSettingsMenuView(); await replyWithInlineMenu(ctx, { menuKind: "settings", text: view.text, keyboard: view.keyboard }); logger.debug("[Navigation] Restored Settings from model menu"); return true; } return false; }
async function handleCatalogListBack(ctx: Context, data: string): Promise<boolean> { if (data !== "commands:list_back" && data !== "skills:list_back") return false; await ctx.answerCallbackQuery().catch(() => {}); if (data === "commands:list_back") await commandsCommand(ctx as never); else await skillsCommand(ctx as never); logger.debug(`[Navigation] Returned from catalog confirm screen: ${data}`); return true; }
async function handleImageAiCallback(ctx: Context, data: string): Promise<boolean> { if (data === "imageai:generate") { activateImageMode("generate"); clearInteractionErrorState("interaction", "image_ai_mode_selected"); await ctx.answerCallbackQuery().catch(() => {}); await ctx.editMessageText("🎨 <b>Image AI · Generate</b>\n\nSend a text or voice prompt and I’ll generate a new image.", { parse_mode: "HTML" }).catch(() => {}); return true; } if (data === "imageai:edit") { activateImageMode("edit"); clearInteractionErrorState("interaction", "image_ai_mode_selected"); await ctx.answerCallbackQuery().catch(() => {}); await ctx.editMessageText("🖌️ <b>Image AI · Edit</b>\n\nSend a photo with a caption/instruction, or send a photo first and then the edit instruction.", { parse_mode: "HTML" }).catch(() => {}); return true; } return false; }
export function registerCallbackRouter(bot: Bot<Context>, deps: CallbackRouterDeps): void {
  const routes = new Map<string, CallbackRoute>([
    ["agent", { name: "agent", handlers: [handleAgentSelect], errorScope: "interaction" }], ["attach", { name: "attach", handlers: [handlePromptAttachmentCancel], errorScope: "interaction" }], ["commands", { name: "commands", handlers: [(ctx) => handleCommandsCallback(ctx, { bot, ensureEventSubscription: deps.ensureEventSubscription })], errorScope: "interaction" }], ["compact", { name: "compact", handlers: [handleCompactConfirm], errorScope: "interaction" }], ["ls", { name: "ls", handlers: [handleLsCallback], errorScope: "interaction" }], ["mcps", { name: "mcps", handlers: [handleMcpsCallback], errorScope: "interaction" }], ["messages", { name: "messages", handlers: [(ctx) => handleMessagesCallback(ctx, { bot, ensureEventSubscription: deps.ensureEventSubscription })], errorScope: "interaction" }], ["mc", { name: "mc", handlers: [handleModelCenterCallback], errorScope: "interaction" }], ["model", { name: "model", handlers: [handleModelSearchCallback, handleModelSearchResults, handleModelProvidersCallback, handleModelSelect], errorScope: "interaction" }], ["role", { name: "role", handlers: [handleAiRoleCallback], errorScope: "interaction" }], ["open", { name: "open", handlers: [(ctx) => handleOpenCallback(ctx, { ensureEventSubscription: deps.ensureEventSubscription })], errorScope: "interaction" }], ["permission", { name: "permission", handlers: [handlePermissionCallback], errorScope: "permission" }], ["question", { name: "question", handlers: [handleQuestionCallback], errorScope: "question" }], ["rename", { name: "rename", handlers: [handleRenameCancel], errorScope: "rename" }], ["session", { name: "session", handlers: [(ctx) => handleSessionPreviewCallback(ctx, { bot, ensureEventSubscription: deps.ensureEventSubscription }), (ctx) => handleSessionSelect(ctx, { bot, ensureEventSubscription: deps.ensureEventSubscription })], errorScope: "interaction" }], ["settings", { name: "settings", handlers: [handleSettingsCallback], errorScope: "none" }], ["skills", { name: "skills", handlers: [(ctx) => handleSkillsCallback(ctx, { bot, ensureEventSubscription: deps.ensureEventSubscription })], errorScope: "interaction" }], ["task", { name: "task", handlers: [handleTaskCallback], errorScope: "taskCreation" }], ["tasklist", { name: "tasklist", handlers: [handleTaskListCallback], errorScope: "interaction" }], ["variant", { name: "variant", handlers: [handleVariantSelect], errorScope: "interaction" }], ["worktree", { name: "worktree", handlers: [(ctx) => handleWorktreeCallback(ctx, { ensureEventSubscription: deps.ensureEventSubscription })], errorScope: "interaction" }], ["provider", { name: "provider", handlers: [handleProviderCallback], errorScope: "interaction" }], ["integration", { name: "integration", handlers: [handleIntegrationsCallback], errorScope: "interaction" }],
  ]);
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery?.data ?? "";
    if (ctx.chat) deps.setTelegramContext(bot, ctx.chat.id);
    if (data === "provider:gemini:configure") markGeminiWizard();
    if (data === "provider:cancel" || data === "provider:menu" || data === "provider:close") clearGeminiWizard();
    let errorScope: InteractionErrorScope = "interaction";
    try {
      if (await handleImageAiCallback(ctx, data)) return;
      if (await handleBackgroundSessionOpen(ctx, { bot, ensureEventSubscription: deps.ensureEventSubscription })) return;
      if (await handleInlineMenuCancel(ctx)) { clearOpenPathIndex(); clearLsPathIndex(); return; }
      if (await handleSettingsChildNavigation(ctx, data)) return;
      if (await handleCatalogListBack(ctx, data)) return;
      const prefix = parseCallbackPrefix(data); const route = prefix ? routes.get(prefix) : undefined;
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
