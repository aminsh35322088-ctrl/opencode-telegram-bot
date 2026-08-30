import type { CommandContext, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { configureGroqStt, deleteCustomProvider, discoverModels, isGroqSttConfigured, removeGroqStt, listCustomProviders, saveCustomProvider, syncOpenCodeCustomConfig } from "../../app/services/custom-provider-service.js";
import { reconcileStoredModelSelection } from "../../app/services/model-selection-service.js";
import { config } from "../../config.js";
import { findServerPid, killServerProcess, resolveLocalOpencodeTarget, startLocalOpencodeServer } from "../../opencode/process.js";
import { logger } from "../../utils/logger.js";
import { clearIntegrationWizard } from "./integrations-command.js";
import { buildAdvancedSettingsView } from "../menus/settings-menu.js";
import { replyWithInlineMenu } from "../menus/inline-menu.js";

const GEMINI_IMAGE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image";
const GEMINI_IMAGE_PROVIDER_ID = "gemini-image";
interface PendingProvider { step: "name" | "url" | "key" | "groq-stt-key" | "gemini-image-key"; name?: string; baseURL?: string; apiKey?: string; messageId: number; }
const pending = new Map<number, PendingProvider>();
function callbackMessageId(ctx: Context): number | null { const message = ctx.callbackQuery?.message; if (!message || !("message_id" in message)) return null; return typeof message.message_id === "number" ? message.message_id : null; }
function wizardKeyboard(): InlineKeyboard { return new InlineKeyboard().text("❌ Cancel", "provider:cancel").text("← Providers", "provider:menu"); }
export function isProviderWizardActive(chatId: number): boolean { return pending.has(chatId); }
export function clearProviderWizard(chatId: number): void { pending.delete(chatId); }
async function deleteInput(ctx: Context): Promise<void> { const messageId = ctx.message?.message_id; if (ctx.chat?.id && messageId) await ctx.api.deleteMessage(ctx.chat.id, messageId).catch(() => {}); }
async function editWizard(ctx: Context, messageId: number, text: string): Promise<void> { if (!ctx.chat?.id) return; await ctx.api.editMessageText(ctx.chat.id, messageId, text, { reply_markup: wizardKeyboard() }); }
async function renderProvidersMenu(ctx: Context, messageId?: number, notice?: string): Promise<void> {
  const providers = await listCustomProviders(); const groqStt = await isGroqSttConfigured(); const gemini = providers.some((p) => p.id === GEMINI_IMAGE_PROVIDER_ID && p.models.some((m) => m.id === GEMINI_IMAGE_MODEL));
  const keyboard = new InlineKeyboard().text("➕ Add custom provider", "provider:add");
  keyboard.row().text(gemini ? "🎨 Configure Gemini / Nano Banana · Active ✅" : "🎨 Configure Gemini / Nano Banana", "provider:gemini:image:configure");
  keyboard.row().text(groqStt ? "🎤 Configure Groq Voice STT · ✅ Active" : "🎤 Configure Groq Voice STT", groqStt ? "provider:stt:groq:remove" : "provider:stt:groq:add");
  for (const provider of providers.filter((p) => p.id !== GEMINI_IMAGE_PROVIDER_ID)) keyboard.row().text(`🧠 ${provider.name}`, `provider:view:${provider.id}`).text("🗑️", `provider:delete:${provider.id}`);
  keyboard.row().text("← Advanced", "provider:advanced").text("✖ Close", "provider:close");
  const customProviders = providers.filter((p) => p.id !== GEMINI_IMAGE_PROVIDER_ID);
  const body = customProviders.length ? `🔌 Custom Providers\n\n${customProviders.map((p) => `• ${p.name} — ${p.baseURL} — ${p.models.length} models`).join("\n")}` : "🔌 Custom Providers\n\nNo custom providers configured yet.";
  const sttLine = groqStt ? "\n\n🎤 Voice transcription: Groq Whisper Large V3 · Active" : "\n\n🎤 Voice transcription: Not configured";
  const geminiLine = gemini ? "\n🎨 Image AI: Gemini / Nano Banana 2 · Active" : "\n🎨 Image AI: Not configured";
  const text = `${notice ? `${notice}\n\n` : ""}${body}${sttLine}${geminiLine}`; const targetMessageId = messageId ?? callbackMessageId(ctx);
  if (targetMessageId !== null && ctx.chat?.id) { await ctx.api.editMessageText(ctx.chat.id, targetMessageId, text, { reply_markup: keyboard }); return; }
  await ctx.reply(text, { reply_markup: keyboard });
}
export async function providersCommand(ctx: CommandContext<Context>): Promise<void> { const chatId = ctx.chat?.id; if (chatId) { clearProviderWizard(chatId); clearIntegrationWizard(chatId); } await renderProvidersMenu(ctx as Context); }
export async function handleProviderCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? ""; if (!data.startsWith("provider:")) return false; const chatId = ctx.chat?.id; if (!chatId) return true;
  if (data === "provider:close") { clearProviderWizard(chatId); clearIntegrationWizard(chatId); await ctx.answerCallbackQuery({ text: "Closed" }).catch(() => {}); await ctx.deleteMessage().catch(() => {}); return true; }
  if (data === "provider:advanced") { clearProviderWizard(chatId); clearIntegrationWizard(chatId); await ctx.answerCallbackQuery().catch(() => {}); const view = buildAdvancedSettingsView(); await replyWithInlineMenu(ctx, { menuKind: "settings", text: view.text, keyboard: view.keyboard }); return true; }
  await ctx.answerCallbackQuery().catch(() => {});
  if (data === "provider:cancel") { const state = pending.get(chatId); pending.delete(chatId); clearIntegrationWizard(chatId); await renderProvidersMenu(ctx, state?.messageId, "❌ Setup cancelled."); return true; }
  if (data === "provider:add") { const messageId = callbackMessageId(ctx); if (messageId === null) return true; clearIntegrationWizard(chatId); pending.set(chatId, { step: "name", messageId }); await editWizard(ctx, messageId, "➕ Add Custom Provider\n\n1/3 · Provider name\n\nExample: TabiToken"); return true; }
  if (data === "provider:gemini:image:configure" || data === "provider:gemini:image:add") { const messageId = callbackMessageId(ctx); if (messageId === null) return true; clearIntegrationWizard(chatId); pending.set(chatId, { step: "gemini-image-key", messageId }); await editWizard(ctx, messageId, "🎨 Configure Gemini / Nano Banana 2\n\nSend your Google AI Studio API key.\n\n🔐 The key is verified before it is stored and is never displayed back to Telegram.\n\nModel: gemini-3.1-flash-image"); return true; }
  if (data === "provider:gemini:image:remove") { const deleted = await deleteCustomProvider(GEMINI_IMAGE_PROVIDER_ID); await syncOpenCodeCustomConfig(); await renderProvidersMenu(ctx, undefined, deleted ? "🎨 Gemini / Nano Banana disabled." : "🎨 Gemini / Nano Banana was not configured."); return true; }
  if (data === "provider:stt:groq:add") { const messageId = callbackMessageId(ctx); if (messageId === null) return true; clearIntegrationWizard(chatId); pending.set(chatId, { step: "groq-stt-key", messageId }); await editWizard(ctx, messageId, "🎤 Configure Groq Voice STT\n\nSend your Groq API key.\n\nThe key is verified against Groq and stored securely on persistent storage. It is never displayed back to Telegram."); return true; }
  if (data === "provider:stt:groq:remove") { const removed = await removeGroqStt(); await renderProvidersMenu(ctx, undefined, removed ? "🎤 Groq Voice STT disabled." : "🎤 Groq Voice STT was not configured."); return true; }
  if (data.startsWith("provider:delete:")) { const id = data.slice("provider:delete:".length); const deleted = await deleteCustomProvider(id); if (deleted) { await syncOpenCodeCustomConfig(); await reconcileStoredModelSelection({ forceCatalogRefresh: true }).catch((error) => logger.warn("[Providers] Model catalog refresh after delete failed:", error)); await renderProvidersMenu(ctx); } else await ctx.answerCallbackQuery({ text: "Provider not found" }).catch(() => {}); return true; }
  if (data.startsWith("provider:view:")) { const id = data.slice("provider:view:".length); const provider = (await listCustomProviders()).find((item) => item.id === id); if (!provider) { await ctx.answerCallbackQuery({ text: "Provider not found" }).catch(() => {}); return true; } await ctx.api.editMessageText(chatId, callbackMessageId(ctx)!, `🔌 ${provider.name}\n\nBase URL: ${provider.baseURL}\nModels:\n${provider.models.map((m) => `• ${m.name} (${m.id})`).join("\n")}\n\n🔐 API key is stored separately and is never displayed.`, { reply_markup: new InlineKeyboard().text("← Providers", "provider:menu").text("✖ Close", "provider:close") }); return true; }
  if (data === "provider:menu") { await renderProvidersMenu(ctx); return true; }
  return true;
}
export async function handleProviderWizardMessage(ctx: Context): Promise<boolean> {
  const chatId = ctx.chat?.id; const text = ctx.message?.text?.trim(); const state = chatId ? pending.get(chatId) : undefined; if (!chatId || !text || !state) return false;
  try {
    if (state.step === "gemini-image-key") {
      await deleteInput(ctx);
      await editWizard(ctx, state.messageId, "🎨 Verifying Gemini / Nano Banana API key…\n\n⏳ Contacting Google Gemini API and checking model access. Please wait.");
      const response = await fetch(`${GEMINI_IMAGE_BASE_URL}/models`, { headers: { "x-goog-api-key": text }, signal: AbortSignal.timeout(15_000) });
      const detail = await response.text().catch(() => "");
      if (!response.ok) throw new Error(`Gemini API key verification failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 220)}` : "."}`);
      let payload: { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> } = {};
      try { payload = JSON.parse(detail) as typeof payload; } catch { /* HTTP 200 with unexpected body is handled below. */ }
      const model = (payload.models ?? []).find((item) => item.name?.endsWith(`/models/${GEMINI_IMAGE_MODEL}`));
      if (!model) throw new Error(`Gemini API key is valid, but ${GEMINI_IMAGE_MODEL} is not available to this project.`);
      await editWizard(ctx, state.messageId, "🎨 Gemini / Nano Banana API key verified.\n\n💾 Saving encrypted-at-rest provider credentials…");
      const saved = await saveCustomProvider({ id: GEMINI_IMAGE_PROVIDER_ID, name: "Gemini / Nano Banana", baseURL: GEMINI_IMAGE_BASE_URL, apiKey: text, models: [{ id: GEMINI_IMAGE_MODEL, name: "Gemini 3.1 Flash Image (Nano Banana 2)" }] });
      pending.delete(chatId); await syncOpenCodeCustomConfig();
      await renderProvidersMenu(ctx, state.messageId, `✅ Gemini / Nano Banana is ready!\n\n🔑 API key: Verified\n🖼️ Image model: ${GEMINI_IMAGE_MODEL}\n🚀 Status: Active`);
      logger.info(`[Providers] Gemini image provider verified and activated: ${GEMINI_IMAGE_MODEL}`);
      return true;
    }
    if (state.step === "groq-stt-key") { await deleteInput(ctx); await editWizard(ctx, state.messageId, "🎤 Verifying Groq API key…"); await configureGroqStt(text); pending.delete(chatId); await renderProvidersMenu(ctx, state.messageId, "✅ Groq Voice STT verified and activated."); return true; }
    if (state.step === "name") { state.name = text; state.step = "url"; await deleteInput(ctx); await editWizard(ctx, state.messageId, "➕ Add Custom Provider\n\n2/3 · Base URL\n\nExample: https://tabitoken.com/v1"); return true; }
    if (state.step === "url") { const baseURL = text.replace(/\/+$/, ""); let parsed: URL; try { parsed = new URL(baseURL); } catch { await deleteInput(ctx); await editWizard(ctx, state.messageId, "➕ Add Custom Provider\n\n2/3 · Base URL\n\n⚠️ Invalid URL. Use an absolute http(s) URL and try again."); return true; } if (parsed.protocol !== "http:" && parsed.protocol !== "https:") { await deleteInput(ctx); await editWizard(ctx, state.messageId, "➕ Add Custom Provider\n\n⚠️ Only http:// and https:// URLs are supported. Try again."); return true; } state.baseURL = baseURL; state.step = "key"; await deleteInput(ctx); await editWizard(ctx, state.messageId, "➕ Add Custom Provider\n\n3/3 · API key\n\nSend the key as a message. It will be deleted when Telegram permits."); return true; }
    state.apiKey = text; await deleteInput(ctx); await editWizard(ctx, state.messageId, "🔎 Testing provider and discovering models…"); const models = await discoverModels(state.baseURL!, state.apiKey!); const saved = await saveCustomProvider({ name: state.name!, baseURL: state.baseURL!, apiKey: state.apiKey!, models }); pending.delete(chatId); const configPath = await syncOpenCodeCustomConfig(); process.env.OPENCODE_CONFIG = configPath; const target = resolveLocalOpencodeTarget(config.opencode.apiUrl); if (target) { const pid = await findServerPid(target.port); if (pid) await killServerProcess(pid); await new Promise((resolve) => setTimeout(resolve, 500)); startLocalOpencodeServer(target).unref(); } await reconcileStoredModelSelection({ forceCatalogRefresh: true }).catch((error) => logger.warn("[Providers] Model catalog refresh after save failed:", error)); await renderProvidersMenu(ctx, state.messageId, `✅ ${saved.name} configured successfully · ${models.length} model${models.length === 1 ? "" : "s"} found`); return true;
  } catch (error) { logger.error("[Providers] Provider wizard failed:", error); const message = error instanceof Error ? error.message : "Unknown error"; await editWizard(ctx, state.messageId, `❌ ${message}\n\nThe key was NOT saved. Send it again to retry, or press Cancel.`).catch(() => {}); return true; }
}
