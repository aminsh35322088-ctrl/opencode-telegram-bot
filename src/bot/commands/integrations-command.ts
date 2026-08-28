import type { CommandContext, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import {
  clearGithubToken,
  getGithubToken,
  getGithubTokenPath,
  saveGithubToken,
} from "../../app/services/github-integration-service.js";

const PENDING_GITHUB = new Set<number>();

export function isGithubTokenWizardActive(chatId: number): boolean {
  return PENDING_GITHUB.has(chatId);
}

export async function showIntegrationsMenu(ctx: Context): Promise<void> {
  const configured = Boolean(await getGithubToken());
  const keyboard = new InlineKeyboard();
  keyboard.text(configured ? "✏️ Change GitHub token" : "➕ Configure GitHub", "integration:github:set");
  if (configured) keyboard.row().text("🗑️ Remove GitHub", "integration:github:remove");
  await ctx.reply(
    `🔌 Integrations\n\nGitHub: ${configured ? "✅ Connected" : "❌ Not configured"}\n\nGitHub access is stored on the persistent /data volume and is used by git/gh tooling.`,
    { reply_markup: keyboard },
  );
}

export async function integrationsCommand(ctx: CommandContext<Context>): Promise<void> {
  await showIntegrationsMenu(ctx);
}

export async function handleIntegrationsCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
  if (!data.startsWith("integration:")) return false;
  await ctx.answerCallbackQuery();
  const chatId = ctx.chat?.id;
  if (!chatId) return true;
  if (data === "integration:menu") {
    await showIntegrationsMenu(ctx);
    return true;
  }
  if (data === "integration:github:set") {
    PENDING_GITHUB.add(chatId);
    await ctx.reply("🔐 Send your GitHub Personal Access Token.\n\nThe message will be deleted when Telegram allows it.");
    return true;
  }
  if (data === "integration:github:remove") {
    await clearGithubToken();
    await ctx.reply("✅ GitHub integration removed.");
    return true;
  }
  return true;
}

export async function handleIntegrationMessage(ctx: Context): Promise<boolean> {
  const chatId = ctx.chat?.id;
  const text = ctx.message?.text?.trim();
  if (!chatId || !text || !PENDING_GITHUB.has(chatId)) return false;
  try {
    await saveGithubToken(text);
    PENDING_GITHUB.delete(chatId);
    await ctx.api.deleteMessage(chatId, ctx.message!.message_id).catch(() => {});
    await ctx.reply(`✅ GitHub connected.\n\nCredential stored securely at ${getGithubTokenPath()} and available to git/gh tooling.`);
  } catch (error) {
    PENDING_GITHUB.delete(chatId);
    await ctx.reply(`❌ Could not save GitHub token.\n\n${error instanceof Error ? error.message : "Unknown error"}`);
  }
  return true;
}
