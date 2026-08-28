import type { CommandContext, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import {
  addGithubAccount,
  getActiveGithubAccount,
  listGithubAccounts,
  removeGithubAccount,
  setActiveGithubAccount,
} from "../../app/services/github-integration-service.js";

interface PendingGithub { step: "name" | "token"; name?: string; }
const pending = new Map<number, PendingGithub>();

export async function showIntegrationsMenu(ctx: Context): Promise<void> {
  const accounts = await listGithubAccounts();
  const active = await getActiveGithubAccount();
  const keyboard = new InlineKeyboard().text("➕ Add GitHub account", "integration:github:add");
  for (const account of accounts) {
    const label = account.id === active?.id ? `✅ ${account.name}` : account.name;
    keyboard.row().text(label, `integration:github:select:${account.id}`).text("🗑️", `integration:github:remove:${account.id}`);
  }
  await ctx.reply(
    `🔌 Integrations\n\nGitHub accounts: ${accounts.length}\nActive: ${active?.name ?? "None"}\n\nAdd multiple GitHub accounts and switch the active credential without changing Railway ENV variables.`,
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
  if (data === "integration:github:add") {
    pending.set(chatId, { step: "name" });
    await ctx.reply("1/2 — GitHub account name?\nExample: Personal GitHub");
    return true;
  }
  if (data.startsWith("integration:github:select:")) {
    const id = data.slice("integration:github:select:".length);
    const account = await setActiveGithubAccount(id);
    await ctx.reply(`✅ Active GitHub account: ${account.name}${account.username ? ` (@${account.username})` : ""}`);
    return true;
  }
  if (data.startsWith("integration:github:remove:")) {
    const id = data.slice("integration:github:remove:".length);
    const removed = await removeGithubAccount(id);
    await ctx.reply(removed ? "✅ GitHub account removed." : "⚠️ GitHub account not found.");
    return true;
  }
  return true;
}

export async function handleIntegrationMessage(ctx: Context): Promise<boolean> {
  const chatId = ctx.chat?.id;
  const text = ctx.message?.text?.trim();
  const state = chatId ? pending.get(chatId) : undefined;
  if (!chatId || !text || !state) return false;
  try {
    if (state.step === "name") {
      state.name = text;
      state.step = "token";
      await ctx.reply("2/2 — Send your GitHub Personal Access Token.\n\nThe token message will be deleted when Telegram allows it.");
      return true;
    }
    const account = await addGithubAccount(state.name!, text);
    pending.delete(chatId);
    await ctx.api.deleteMessage(chatId, ctx.message!.message_id).catch(() => {});
    await ctx.reply(`✅ GitHub account “${account.name}” added and selected.`);
  } catch (error) {
    pending.delete(chatId);
    await ctx.reply(`❌ Could not add GitHub account.\n\n${error instanceof Error ? error.message : "Unknown error"}`);
  }
  return true;
}
