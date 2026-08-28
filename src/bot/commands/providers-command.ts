import type { CommandContext, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { deleteCustomProvider, discoverModels, listCustomProviders, saveCustomProvider, syncOpenCodeCustomConfig } from "../../app/services/custom-provider-service.js";
import { config } from "../../config.js";
import { findServerPid, killServerProcess, resolveLocalOpencodeTarget, startLocalOpencodeServer } from "../../opencode/process.js";
import { logger } from "../../utils/logger.js";

interface PendingProvider { step: "name" | "url" | "key"; name?: string; baseURL?: string; apiKey?: string; }
const pending = new Map<number, PendingProvider>();

export function isProviderWizardActive(chatId: number): boolean { return pending.has(chatId); }

async function replyNext(ctx: Context, text: string): Promise<void> {
  await ctx.reply(text, { reply_markup: { force_reply: true, selective: true } });
}

export async function providersCommand(ctx: CommandContext<Context>): Promise<void> {
  const providers = await listCustomProviders();
  const keyboard = new InlineKeyboard().text("➕ Add custom provider", "provider:add");
  for (const provider of providers) keyboard.row().text(`🧠 ${provider.name}`, `provider:view:${provider.id}`).text("🗑️", `provider:delete:${provider.id}`);
  const text = providers.length
    ? `🔌 Custom Providers\n\n${providers.map((p) => `• ${p.name} — ${p.baseURL} — ${p.models.length} models`).join("\n")}\n\nAdd or manage an OpenAI-compatible provider.`
    : "🔌 Custom Providers\n\nNo custom providers configured yet.\n\nAdd any OpenAI-compatible API exposing /v1/chat/completions.";
  await ctx.reply(text, { reply_markup: keyboard });
}

export async function handleProviderCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
  if (!data.startsWith("provider:")) return false;
  await ctx.answerCallbackQuery();
  const chatId = ctx.chat?.id;
  if (!chatId) return true;
  if (data === "provider:add") { pending.set(chatId, { step: "name" }); await replyNext(ctx, "1/3 — Provider name?\nExample: TabiToken"); return true; }
  if (data.startsWith("provider:delete:")) {
    const id = data.slice("provider:delete:".length); const deleted = await deleteCustomProvider(id);
    if (deleted) { await syncOpenCodeCustomConfig(); await ctx.reply(`✅ Provider ${id} deleted. Restart OpenCode to apply the change.`); }
    else await ctx.reply("Provider not found.");
    return true;
  }
  if (data.startsWith("provider:view:")) {
    const id = data.slice("provider:view:".length); const provider = (await listCustomProviders()).find((item) => item.id === id);
    if (!provider) { await ctx.reply("Provider not found."); return true; }
    await ctx.reply(`🔌 ${provider.name}\n\nBase URL: ${provider.baseURL}\nModels:\n${provider.models.map((m) => `• ${m.name} (${m.id})`).join("\n")}\n\n🔐 API key is stored separately and is never displayed.`);
    return true;
  }
  return true;
}

export async function handleProviderWizardMessage(ctx: Context): Promise<boolean> {
  const chatId = ctx.chat?.id; const text = ctx.message?.text?.trim();
  if (!chatId || !text || !pending.has(chatId)) return false;
  const state = pending.get(chatId)!;
  try {
    if (state.step === "name") { state.name = text; state.step = "url"; await replyNext(ctx, "2/3 — Base URL?\nExample: https://tabitoken.com/v1"); return true; }
    if (state.step === "url") { state.baseURL = text.replace(/\/$/, ""); new URL(state.baseURL); state.step = "key"; await replyNext(ctx, "3/3 — API key?\nIt will be stored in a private file. After receiving it, this message is deleted when possible."); return true; }
    state.apiKey = text; await ctx.deleteMessage().catch(() => {}); await ctx.reply("🔎 Testing the provider and discovering models...");
    const models = await discoverModels(state.baseURL!, state.apiKey!);
    const saved = await saveCustomProvider({ name: state.name!, baseURL: state.baseURL!, apiKey: state.apiKey!, models });
    pending.delete(chatId);
    const configPath = await syncOpenCodeCustomConfig(); process.env.OPENCODE_CONFIG = configPath;
    const target = resolveLocalOpencodeTarget(config.opencode.apiUrl);
    if (target) { const pid = await findServerPid(target.port); if (pid) await killServerProcess(pid); await new Promise((resolve) => setTimeout(resolve, 500)); startLocalOpencodeServer(target).unref(); }
    await ctx.reply(`✅ ${saved.name} configured successfully.\n\nFound ${models.length} models.\nOpenCode was restarted to load the provider.\n\nUse /models to select one.`);
    return true;
  } catch (error) {
    pending.delete(chatId); logger.error("[Providers] Provider wizard failed:", error);
    await ctx.reply(`❌ Could not configure provider.\n\n${error instanceof Error ? error.message : "Unknown error"}`); return true;
  }
}
