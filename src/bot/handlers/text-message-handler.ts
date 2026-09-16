import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import { t } from "../../i18n/index.js";
import { handleMcpsMessage } from "../commands/mcp-catalog-command.js";
import {
  clearCommandsInteraction,
  clearCommandsMenu,
  executeCommand,
  parseCommandsMetadata,
  type ExecuteCommandDeps,
} from "../callbacks/command-catalog-callback-handler.js";
import {
  clearSkillsInteraction,
  executeSkill,
  parseSkillsMetadata,
} from "../callbacks/skills-catalog-callback-handler.js";

async function deleteInput(ctx: Context): Promise<void> {
  if (!ctx.chat?.id || !ctx.message?.message_id) return;
  await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
}

async function editPanel(
  ctx: Context,
  messageId: number,
  text: string,
  backCallback: string,
): Promise<void> {
  if (!ctx.chat?.id) return;
  await ctx.api.editMessageText(ctx.chat.id, messageId, text, {
    reply_markup: new InlineKeyboard().text("← Back", backCallback).text("🏠 Home", "main:home"),
  }).catch(() => {});
}

export async function handleCommandTextArguments(ctx: Context, deps: ExecuteCommandDeps): Promise<boolean> {
  const text = ctx.message?.text;
  if (!text || text.startsWith("/")) return false;

  const metadata = parseCommandsMetadata(interactionManager.getSnapshot());
  if (!metadata || metadata.stage !== "confirm") return false;

  const argumentsText = text.trim();
  await deleteInput(ctx);
  if (!argumentsText) {
    await editPanel(ctx, metadata.messageId, t("commands.arguments_empty"), "commands:list_back");
    return true;
  }

  clearCommandsMenu(metadata.messageId);
  clearCommandsInteraction("commands_arguments_submitted");
  await editPanel(ctx, metadata.messageId, `▶️ /${metadata.commandName}\n\nExecution started.`, "commands:list_back");
  await executeCommand(ctx, deps, {
    projectDirectory: metadata.projectDirectory,
    commandName: metadata.commandName,
    argumentsText,
  });
  return true;
}

export async function handleSkillTextArguments(ctx: Context, deps: ExecuteCommandDeps): Promise<boolean> {
  const text = ctx.message?.text;
  if (!text || text.startsWith("/")) return false;

  const metadata = parseSkillsMetadata(interactionManager.getSnapshot());
  if (!metadata || metadata.stage !== "confirm") return false;

  const argumentsText = text.trim();
  await deleteInput(ctx);
  if (!argumentsText) {
    await editPanel(ctx, metadata.messageId, t("skills.arguments_empty"), "skills:list_back");
    return true;
  }

  clearSkillsInteraction("skills_arguments_submitted");
  await editPanel(ctx, metadata.messageId, `▶️ /${metadata.skillName}\n\nExecution started.`, "skills:list_back");
  await executeSkill(ctx, deps, {
    projectDirectory: metadata.projectDirectory,
    skillName: metadata.skillName,
    argumentsText,
  });
  return true;
}

export async function handleCatalogTextArguments(ctx: Context, deps: ExecuteCommandDeps): Promise<boolean> {
  if (await handleMcpsMessage(ctx)) return true;
  if (await handleCommandTextArguments(ctx, deps)) return true;
  return handleSkillTextArguments(ctx, deps);
}