import type { Bot, Context, NextFunction } from "grammy";
import { config } from "../../config.js";
import { settingsCommand } from "../commands/settings-command.js";
import { providersCommand, handleProviderWizardMessage, clearProviderWizard } from "../commands/providers-command.js";
import { integrationsCommand, handleIntegrationMessage } from "../commands/integrations-command.js";
import { opencodeStartCommand } from "../commands/opencode-start-command.js";
import { opencodeStopCommand } from "../commands/opencode-stop-command.js";
import { worktreeCommand } from "../commands/worktree-command.js";
import { openCommand } from "../commands/open-command.js";
import { lsCommand } from "../commands/ls-command.js";
import { messagesCommand } from "../commands/messages-command.js";
import { abortCommand } from "../commands/abort-command.js";
import { pauseCurrentChat, resumePausedChat } from "../commands/pause-command.js";
import { detachCommand } from "../commands/detach-command.js";
import { taskCommand } from "../commands/task-command.js";
import { taskListCommand } from "../commands/tasklist-command.js";
import { renameCommand } from "../commands/rename-command.js";
import { commandsCommand } from "../commands/command-catalog-command.js";
import { skillsCommand } from "../commands/skills-catalog-command.js";
import { mcpsCommand } from "../commands/mcp-catalog-command.js";
import { startCommand } from "../commands/start-command.js";
import { helpCommand } from "../commands/help-command.js";
import { statusCommand } from "../commands/status-command.js";
import { updateCommand } from "../commands/update-command.js";
import { allVersionInfoCommand } from "../commands/all-version-info-command.js";
import { memoryCommand, rememberCommand, forgetCommand } from "../commands/memory-command.js";
import { imageCommand, editCommand } from "../commands/media-command.js";
import { BOT_COMMANDS } from "../commands/definitions.js";
import { logger } from "../../utils/logger.js";
import { flushPendingPrompt } from "../handlers/message-merger.js";
import { isGeminiWizardActive, clearGeminiWizard, clearProviderWizard as clearProviderWizardState } from "../services/gemini-wizard-state.js";
import { verifyAndSaveGeminiChatProvider } from "../../app/services/gemini-chat-service.js";
import { getTopicRuntimeContext } from "../../app/services/topic-runtime-context.js";
import { showModelCenterMenu } from "../menus/model-center-menu.js";
import { showAgentSelectionMenu } from "../menus/agent-selection-menu.js";
import { showVariantSelectionMenu } from "../menus/variant-selection-menu.js";
import { handleContextButtonPress } from "../menus/context-control-menu.js";
import { getCompactOutputMode, setCompactOutputMode } from "../../app/stores/settings-store.js";
import { keyboardManager } from "../keyboards/keyboard-manager.js";
import { showTelegramTopicDeleteConfirmation } from "../services/telegram-topic-delete-handler.js";

interface CommandRouterDeps { ensureEventSubscription: (directory: string) => Promise<void>; clearRuntimeState: (reason: string) => void; }
let commandsInitialized = false;

export async function ensureCommandsInitialized(ctx: Context, next: NextFunction): Promise<void> {
  if (commandsInitialized || !ctx.from || ctx.from.id !== config.telegram.allowedUserId) { await next(); return; }
  if (!ctx.chat) { logger.warn("[Bot] Cannot initialize commands: chat context is missing"); await next(); return; }
  try { await ctx.api.setMyCommands(BOT_COMMANDS, { scope: { type: "chat", chat_id: ctx.chat.id } }); commandsInitialized = true; }
  catch (err) { logger.error("[Bot] Failed to set commands:", err); }
  await next();
}

function isAiTopicCommandContext(): boolean {
  const runtime = getTopicRuntimeContext();
  return runtime?.sessionId !== undefined && typeof runtime.threadId === "number" && runtime.threadId > 1;
}

async function requireAiTopic(ctx: Context, command: string): Promise<boolean> {
  if (isAiTopicCommandContext()) return true;
  await ctx.reply(`ℹ️ /${command} is only available inside an AI Topic.`);
  return false;
}

export function registerCommandRouter(bot: Bot<Context>, deps: CommandRouterDeps): void {
  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.message?.text?.startsWith("/")) flushPendingPrompt(ctx.chat.id);
    if (ctx.message?.text && ctx.chat) {
      if (isGeminiWizardActive() && !ctx.message.text.startsWith("/")) {
        try {
          await verifyAndSaveGeminiChatProvider(ctx.message.text);
          clearGeminiWizard();
          clearProviderWizardState();
          await ctx.reply("✅ Gemini API verified and activated.\n\n🤖 Chat model: gemini-3.1-flash-lite\n💸 Free Tier model");
        } catch (error) {
          clearGeminiWizard();
          const message = error instanceof Error ? error.message : String(error);
          await ctx.reply(`❌ Gemini API verification failed.\n\n${message}\n\nThe key was NOT saved. Open Configure Gemini and try again.`);
        }
        return;
      }
      if (await handleProviderWizardMessage(ctx)) return;
      if (await handleIntegrationMessage(ctx)) return;
    }
    await next();
  });

  bot.hears(/^⚙(?:️)? (?:Main Settings|Topic Settings|Settings)$/u, async (ctx) => {
    try {
      await settingsCommand(ctx as never);
    } catch (error) {
      logger.error("[Bot] Error opening settings from reply keyboard:", error);
      await ctx.reply("❌ Could not open Settings. Please try again.");
    }
  });

  bot.command("start", startCommand);
  bot.command("update", updateCommand);
  bot.command("all", allVersionInfoCommand);
  bot.command("help", helpCommand);
  bot.command("status", statusCommand);
  bot.command("settings", settingsCommand);
  bot.command("topic_settings", async (ctx) => {
    if (await requireAiTopic(ctx, "topic_settings")) await settingsCommand(ctx as never);
  });
  bot.command("providers", providersCommand);
  bot.command("integrations", integrationsCommand);
  bot.command("opencode_start", opencodeStartCommand);
  bot.command("opencode_stop", (ctx) => opencodeStopCommand(ctx, { clearRuntimeState: deps.clearRuntimeState }));
  bot.command("worktree", worktreeCommand);
  bot.command("open", openCommand);
  bot.command("ls", lsCommand);
  bot.command("messages", messagesCommand);
  bot.command("abort", abortCommand);
  bot.command("stop", abortCommand);
  bot.command("pause", async (ctx) => {
    if (await requireAiTopic(ctx, "pause")) await pauseCurrentChat(ctx);
  });
  bot.command("resume", async (ctx) => {
    if (await requireAiTopic(ctx, "resume")) await resumePausedChat(ctx, { bot, ensureEventSubscription: deps.ensureEventSubscription });
  });
  bot.command("model", async (ctx) => {
    if (await requireAiTopic(ctx, "model")) await showModelCenterMenu(ctx);
  });
  bot.command("agent", async (ctx) => {
    if (await requireAiTopic(ctx, "agent")) await showAgentSelectionMenu(ctx);
  });
  bot.command("variant", async (ctx) => {
    if (await requireAiTopic(ctx, "variant")) await showVariantSelectionMenu(ctx);
  });
  bot.command("context", async (ctx) => {
    if (await requireAiTopic(ctx, "context")) await handleContextButtonPress(ctx);
  });
  bot.command("compact", async (ctx) => {
    if (!(await requireAiTopic(ctx, "compact"))) return;
    const enabled = !getCompactOutputMode();
    setCompactOutputMode(enabled);
    const runtime = getTopicRuntimeContext();
    if (runtime?.sessionId) await keyboardManager.sendKeyboardUpdate(runtime.chatId, true, runtime.sessionId);
    await ctx.reply(`📦 Compact Mode: ${enabled ? "ON" : "OFF"}`);
  });
  bot.command("delete_topic", async (ctx) => {
    if (await requireAiTopic(ctx, "delete_topic")) await showTelegramTopicDeleteConfirmation(ctx);
  });
  bot.command("detach", detachCommand);
  bot.command("task", taskCommand);
  bot.command("tasklist", taskListCommand);
  bot.command("rename", renameCommand);
  bot.command("commands", commandsCommand);
  bot.command("skills", skillsCommand);
  bot.command("mcps", mcpsCommand);
  bot.command("memory", memoryCommand);
  bot.command("remember", rememberCommand);
  bot.command("forget", forgetCommand);
  bot.command("image", imageCommand);
  bot.command("edit", editCommand);
}
