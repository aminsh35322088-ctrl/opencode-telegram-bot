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
import { sessionsCommand } from "../commands/sessions-command.js";
import { messagesCommand } from "../commands/messages-command.js";
import { abortCommand } from "../commands/abort-command.js";
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
import { isGeminiWizardActive, clearGeminiWizard } from "../services/gemini-wizard-state.js";
import { verifyAndSaveGeminiChatProvider } from "../../app/services/gemini-chat-service.js";

interface CommandRouterDeps { ensureEventSubscription: (directory: string) => Promise<void>; clearRuntimeState: (reason: string) => void; }
let commandsInitialized = false;
export async function ensureCommandsInitialized(ctx: Context, next: NextFunction): Promise<void> { if (commandsInitialized || !ctx.from || ctx.from.id !== config.telegram.allowedUserId) { await next(); return; } if (!ctx.chat) { logger.warn("[Bot] Cannot initialize commands: chat context is missing"); await next(); return; } try { await ctx.api.setMyCommands(BOT_COMMANDS, { scope: { type: "chat", chat_id: ctx.chat.id } }); commandsInitialized = true; } catch (err) { logger.error("[Bot] Failed to set commands:", err); } await next(); }
export function registerCommandRouter(bot: Bot<Context>, deps: CommandRouterDeps): void {
  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.message?.text?.startsWith("/")) flushPendingPrompt(ctx.chat.id);
    if (ctx.message?.text && ctx.chat) {
      if (isGeminiWizardActive() && !ctx.message.text.startsWith("/")) {
        try {
          await verifyAndSaveGeminiChatProvider(ctx.message.text);
          clearGeminiWizard();
          clearProviderWizard();
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
  bot.command("start", startCommand); bot.command("update", updateCommand); bot.command("all", allVersionInfoCommand); bot.command("help", helpCommand); bot.command("status", statusCommand); bot.command("settings", settingsCommand); bot.command("providers", providersCommand); bot.command("integrations", integrationsCommand); bot.command("opencode_start", opencodeStartCommand); bot.command("opencode_stop", (ctx) => opencodeStopCommand(ctx, { clearRuntimeState: deps.clearRuntimeState })); bot.command("worktree", worktreeCommand); bot.command("open", openCommand); bot.command("ls", lsCommand); bot.command("sessions", sessionsCommand); bot.command("messages", messagesCommand); bot.command("abort", abortCommand); bot.command("detach", detachCommand); bot.command("task", taskCommand); bot.command("tasklist", taskListCommand); bot.command("rename", renameCommand); bot.command("commands", commandsCommand); bot.command("skills", skillsCommand); bot.command("mcps", mcpsCommand); bot.command("memory", memoryCommand); bot.command("remember", rememberCommand); bot.command("forget", forgetCommand); bot.command("image", imageCommand); bot.command("edit", editCommand);
}
