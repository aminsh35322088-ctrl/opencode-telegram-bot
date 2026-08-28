import type { CommandContext, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { deleteCustomProvider, discoverModels, listCustomProviders, saveCustomProvider, syncOpenCodeCustomConfig } from "../../app/services/custom-provider-service.js";
import { config } from "../../config.js";
import { findServerPid, killServerProcess, resolveLocalOpencodeTarget, startLocalOpencodeServer } from "../../opencode/process.js";
import { logger } from "../../utils/logger.js";
import { clearIntegrationWizard } from "./integrations-command.js";
import { settingsCommand } from "./settings-command.js";

interface PendingProvider {
  step: "name" | "url" | "key";
  name?: string;
  baseURL?: string;
  apiKey?: string;
  messageId: number;
}

const pending = new Map<number, PendingProvider>();

function callbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  if (!message || !("message_id" in message)) return null;
  return typeof message.message_id === "number" ? message.message_id : null;
}

function wizardKeyboard(): InlineKeyboard { return new InlineKeyboard().text("❌ Cancel", "provider:cancel"); }

export function isProviderWizardActive(chatId: number): boolean { return pending.has(chatId); }
export function clearProviderWizard(chatId: number): void { pending.delete(chatId); }

async function deleteInput(ctx: Context): Promise<void> {
  const messageId = ctx.message?.message_id;
  if (ctx.chat?.id && messageId) await ctx.api.deleteMessage(ctx.chat.id, messageId).catch(() => {});
}

async function editWizard(ctx: Context, messageId: number, text: string): Promise<void> {
  await ctx.api.editMessageText(ctx.chat!.id, messageId, text, { reply_markup: wizardKeyboard() });
}

async function renderProvidersMenu(ctx: Context, messageId?: number, notice?: string): Promise<void> {
  const providers = await listCustomProviders();
  const keyboard = new InlineKeyboard().text("➕ Add custom provider", "provider:add");
  for (const provider of providers) {
    keyboard.row().text(`🧠 ${provider.name}`, `provider:view:${provider.id}`).text("🗑️", `provider:delete:${provider.id}`);
  }
  keyboard.row().text("🔙 Back", "provider:settings");
  const body = providers.length
    ? `🔌 Custom Providers\n\n${providers.map((p) => `• ${p.name} — ${p.baseURL} — ${p.models.length} models`).join("\n")}`
    : "🔌 Custom Providers\n\nNo custom providers configured yet.";
  const text = notice ? `${notice}\n\n${body}` : body;
  const targetMessageId = messageId ?? callbackMessageId(ctx);
  if (targetMessageId !== null && ctx.chat?.id) {
    await ctx.api.editMessageText(ctx.chat.id, targetMessageId, text, { reply_markup: keyboard });
    return;
  }
  await ctx.reply(text, { reply_markup: keyboard });
}

export async function providersCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId) { clearProviderWizard(chatId); clearIntegrationWizard(chatId); }
  await renderProvidersMenu(ctx as Context);
}

export async function handleProviderCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
  if (!data.startsWith("provider:")) return false;
  await ctx.answerCallbackQuery();
  const chatId = ctx.chat?.id;
  if (!chatId) return true;

  if (data === "provider:cancel") {
    const state = pending.get(chatId);
    pending.delete(chatId);
    clearIntegrationWizard(chatId);
    await renderProvidersMenu(ctx, state?.messageId);
    return true;
  }

  if (data === "provider:settings") {
    clearProviderWizard(chatId);
    clearIntegrationWizard(chatId);
    await settingsCommand(ctx as never);
    return true;
  }

  if (data === "provider:add") {
    const messageId = callbackMessageId(ctx);
    if (messageId === null) {
      await ctx.answerCallbackQuery({ text: "This menu has expired. Please open Providers again.", show_alert: true }).catch(() => {});
      return true;
    }
    clearIntegrationWizard(chatId);
    pending.set(chatId, { step: "name", messageId });
    await editWizard(ctx, messageId, "➕ Add Custom Provider\n\n1/3 · Provider name\n\nExample: TabiToken");
    return true;
  }

  if (data.startsWith("provider:delete:")) {
    const id = data.slice("provider:delete:".length);
    const deleted = await deleteCustomProvider(id);
    if (deleted) {
      await syncOpenCodeCustomConfig();
      await renderProvidersMenu(ctx);
    } else {
      await ctx.answerCallbackQuery({ text: "Provider not found" }).catch(() => {});
    }
    return true;
  }

  if (data.startsWith("provider:view:")) {
    const id = data.slice("provider:view:".length);
    const provider = (await listCustomProviders()).find((item) => item.id === id);
    if (!provider) {
      await ctx.answerCallbackQuery({ text: "Provider not found" }).catch(() => {});
      return true;
    }
    await ctx.api.editMessageText(chatId, callbackMessageId(ctx)!, `🔌 ${provider.name}\n\nBase URL: ${provider.baseURL}\nModels:\n${provider.models.map((m) => `• ${m.name} (${m.id})`).join("\n")}\n\n🔐 API key is stored separately and is never displayed.`, { reply_markup: new InlineKeyboard().text("🔙 Back", "provider:menu") });
    return true;
  }

  if (data === "provider:menu") {
    await renderProvidersMenu(ctx);
    return true;
  }
  return true;
}

export async function handleProviderWizardMessage(ctx: Context): Promise<boolean> {
  const chatId = ctx.chat?.id;
  const text = ctx.message?.text?.trim();
  const state = chatId ? pending.get(chatId) : undefined;
  if (!chatId || !text || !state) return false;

  try {
    if (state.step === "name") {
      state.name = text;
      state.step = "url";
      await deleteInput(ctx);
      await editWizard(ctx, state.messageId, "➕ Add Custom Provider\n\n2/3 · Base URL\n\nExample: https://tabitoken.com/v1");
      return true;
    }

    if (state.step === "url") {
      const baseURL = text.replace(/\/+$/, "");
      let parsed: URL;
      try { parsed = new URL(baseURL); } catch { await deleteInput(ctx); await editWizard(ctx, state.messageId, "➕ Add Custom Provider\n\n2/3 · Base URL\n\n⚠️ Invalid URL. Use an absolute http(s) URL and try again."); return true; }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        await deleteInput(ctx); await editWizard(ctx, state.messageId, "➕ Add Custom Provider\n\n2/3 · Base URL\n\n⚠️ Only http:// and https:// URLs are supported. Try again.");
        return true;
      }
      state.baseURL = baseURL;
      state.step = "key";
      await deleteInput(ctx);
      await editWizard(ctx, state.messageId, "➕ Add Custom Provider\n\n3/3 · API key\n\nSend the key as a message. It will be deleted when Telegram permits.");
      return true;
    }

    state.apiKey = text;
    await deleteInput(ctx);
    await editWizard(ctx, state.messageId, "🔎 Testing provider and discovering models…");
    const models = await discoverModels(state.baseURL!, state.apiKey!);
    const saved = await saveCustomProvider({ name: state.name!, baseURL: state.baseURL!, apiKey: state.apiKey!, models });
    pending.delete(chatId);
    const configPath = await syncOpenCodeCustomConfig();
    process.env.OPENCODE_CONFIG = configPath;
    const target = resolveLocalOpencodeTarget(config.opencode.apiUrl);
    if (target) {
      const pid = await findServerPid(target.port);
      if (pid) await killServerProcess(pid);
      await new Promise((resolve) => setTimeout(resolve, 500));
      startLocalOpencodeServer(target).unref();
    }
    await renderProvidersMenu(ctx, state.messageId, `✅ ${saved.name} configured successfully · ${models.length} model${models.length === 1 ? "" : "s"} found`);
    return true;
  } catch (error) {
    logger.error("[Providers] Provider wizard failed:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    await editWizard(ctx, state.messageId, `➕ Add Custom Provider\n\n3/3 · API key\n\n❌ ${message}\n\nSend the API key again to retry, or press Cancel.`).catch(() => {});
    return true;
  }
}
