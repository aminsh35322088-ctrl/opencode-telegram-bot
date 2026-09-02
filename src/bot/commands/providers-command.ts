import type { CommandContext, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { configureGroqStt, deleteCustomProvider, discoverModels, isGroqSttConfigured, removeGroqStt, listCustomProviders, saveCustomProvider, syncOpenCodeCustomConfig, type AiCapability } from "../../app/services/custom-provider-service.js";
import { configureCloudflareCredentials, configureImageAiProvider, IMAGE_AI_PROVIDER_IDS, listImageAiProviders, removeCloudflareCredentials, removeImageAiProvider, validateConfiguredCloudflareCredentials } from "../../app/services/image-ai-provider-service.js";
import { reconcileStoredModelSelection } from "../../app/services/model-selection-service.js";
import { config } from "../../config.js";
import { findServerPid, killServerProcess, resolveLocalOpencodeTarget, startLocalOpencodeServer } from "../../opencode/process.js";
import { logger } from "../../utils/logger.js";
import { clearIntegrationWizard } from "./integrations-command.js";
import { buildAdvancedSettingsView } from "../menus/settings-menu.js";
import { replyWithInlineMenu } from "../menus/inline-menu.js";

const GEMINI_PROVIDER_ID = "gemini";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
const GEMINI_MODEL = "gemini-3.1-flash-lite";
const LEGACY_GEMINI_IMAGE_PROVIDER_ID = "gemini-image";
const CAPABILITIES: AiCapability[] = ["coding", "image", "video", "stt"];
const LABEL: Record<AiCapability, string> = { coding: "💻 Coding AI", image: "🎨 Image AI", video: "🎬 Video AI", stt: "🎙️ Speech-to-Text" };
type ImageStep = "image-cloudflare-account" | "image-cloudflare-token" | "image-custom-base-url" | "image-custom-model" | "image-custom-edit-model" | "image-custom-key";
interface PendingProvider { step: "slot" | "name" | "url" | "key" | "groq-stt-key" | "gemini-chat-key" | ImageStep; capability?: AiCapability; name?: string; baseURL?: string; apiKey?: string; model?: string; editModel?: string; accountId?: string; messageId: number; }
let pending: PendingProvider | null = null;
function messageId(ctx: Context): number | null { const m = ctx.callbackQuery?.message; return m && "message_id" in m && typeof m.message_id === "number" ? m.message_id : null; }
function wizardKeyboard(back = "provider:menu") { return new InlineKeyboard().text("❌ Cancel", "provider:cancel").text("← Back", back); }
export function isProviderWizardActive(): boolean { return pending !== null; }
export function clearProviderWizard(): void { pending = null; }
async function deleteInput(ctx: Context) { const id = ctx.message?.message_id; if (ctx.chat?.id && id) await ctx.api.deleteMessage(ctx.chat.id, id).catch(() => {}); }
async function editWizard(ctx: Context, id: number, text: string, back = "provider:menu") { if (ctx.chat?.id) await ctx.api.editMessageText(ctx.chat.id, id, text, { reply_markup: wizardKeyboard(back) }); }
async function restartOpenCodeAfterProviderChange() { const configPath = await syncOpenCodeCustomConfig(); process.env.OPENCODE_CONFIG = configPath; const target = resolveLocalOpencodeTarget(config.opencode.apiUrl); if (target) { const pid = await findServerPid(target.port); if (pid) await killServerProcess(pid); await new Promise((r) => setTimeout(r, 500)); startLocalOpencodeServer(target).unref(); } await reconcileStoredModelSelection({ forceCatalogRefresh: true }).catch((e) => logger.warn("[Providers] Model refresh failed:", e)); }

async function renderImage(ctx: Context, id?: number, notice?: string) {
  const providers = await listImageAiProviders();
  const cloudflare = providers.find((p) => p.id === IMAGE_AI_PROVIDER_IDS.CLOUDFLARE_ID);
  const custom = providers.find((p) => p.id === IMAGE_AI_PROVIDER_IDS.CUSTOM_ID);
  const cloudflareValidation = cloudflare ? await validateConfiguredCloudflareCredentials() : { valid: false };
  const k = new InlineKeyboard();
  k.row().text(cloudflare ? "☁️ Cloudflare Workers AI · Active ✅" : "☁️ Cloudflare Workers AI", "provider:image:cloudflare:configure");
  k.row().text(custom ? "🔌 Custom API · Active ✅" : "🔌 Custom API", "provider:image:custom:configure");
  if (cloudflare || custom) k.row().text("🗑️ Remove active provider", "provider:image:remove");
  k.row().text("← Custom Provider API", "provider:menu").text("✖ Close", "provider:close");
  const status = cloudflare ? (cloudflareValidation.valid ? "✅ Verified" : "⚠️ Needs verification") : "⚪ Not configured";
  const lines = [
    `☁️ Cloudflare Workers AI: ${status}`,
    cloudflare ? `Model: ${cloudflare.model}` : "",
    `🔌 Custom API: ${custom ? `✅ ${custom.model}${custom.editModel ? ` / edit: ${custom.editModel}` : ""}` : "⚪ Not configured"}`,
  ].filter(Boolean);
  const text = `${notice ? `${notice}\n\n` : ""}🎨 Image AI\n\n${lines.join("\n")}\n\nChoose one provider. Cloudflare supports generation + editing with FLUX.2 Klein 4B.`;
  if (id !== undefined && ctx.chat?.id) await ctx.api.editMessageText(ctx.chat.id, id, text, { reply_markup: k }); else await ctx.reply(text, { reply_markup: k });
}

async function renderSlot(ctx: Context, c: AiCapability, id?: number, notice?: string) {
  if (c === "image") { await renderImage(ctx, id, notice); return; }
  const ps = await listCustomProviders(); const list = ps.filter((p) => p.capability === c); const k = new InlineKeyboard();
  for (const p of list) k.row().text(`🧠 ${p.name} · Active ✅`, `provider:view:${p.id}`).text("🗑️", `provider:delete:${p.id}`);
  k.row().text("➕ Add provider", `provider:add:${c}`);
  if (c === "stt") k.row().text(await isGroqSttConfigured() ? "🎤 Groq · Active ✅" : "🎤 Groq Voice STT", "provider:stt:groq:add");
  k.row().text("← Providers", "provider:menu").text("✖ Close", "provider:close");
  const body = list.length ? list.map((p) => `✅ ${p.name}\n${p.models.length} verified model${p.models.length === 1 ? "" : "s"}`).join("\n\n") : "⚪ No verified custom provider in this slot.";
  const text = `${notice ? `${notice}\n\n` : ""}${LABEL[c]}\n\n${body}`;
  if (id !== undefined && ctx.chat?.id) await ctx.api.editMessageText(ctx.chat.id, id, text, { reply_markup: k }); else await ctx.reply(text, { reply_markup: k });
}
async function renderProviders(ctx: Context, id?: number, notice?: string) {
  const ps = await listCustomProviders(); const k = new InlineKeyboard();
  for (const c of CAPABILITIES) k.row().text(LABEL[c], `provider:slot:${c}`);
  k.row().text("← Advanced", "provider:advanced").text("✖ Close", "provider:close");
  const text = `${notice ? `${notice}\n\n` : ""}🔌 Custom Provider API\n\n${CAPABILITIES.map((c) => `${LABEL[c]}: ${ps.filter((p) => p.capability === c).map((p) => p.name).join(", ") || "Not configured"}`).join("\n")}\n\nImage AI has only two provider types: Cloudflare Workers AI and Custom API.`;
  if (id !== undefined && ctx.chat?.id) await ctx.api.editMessageText(ctx.chat.id, id, text, { reply_markup: k }); else await ctx.reply(text, { reply_markup: k });
}
export async function providersCommand(ctx: CommandContext<Context>) { clearProviderWizard(); clearIntegrationWizard(); await renderProviders(ctx as Context); }

export async function handleProviderCallback(ctx: Context): Promise<boolean> {
  const d = ctx.callbackQuery?.data ?? ""; if (!d.startsWith("provider:")) return false; const chat = ctx.chat?.id; if (!chat) return true;
  if (d === "provider:close") { clearProviderWizard(); await ctx.answerCallbackQuery({ text: "Closed" }).catch(() => {}); await ctx.deleteMessage().catch(() => {}); return true; }
  if (d === "provider:advanced") { await ctx.answerCallbackQuery().catch(() => {}); const v = buildAdvancedSettingsView(); const id = messageId(ctx); if (id !== null) await ctx.api.editMessageText(chat, id, v.text, { reply_markup: v.keyboard }); else await replyWithInlineMenu(ctx, { menuKind: "settings", text: v.text, keyboard: v.keyboard }); return true; }
  await ctx.answerCallbackQuery().catch(() => {});
  if (d === "provider:cancel") { clearProviderWizard(); const id = messageId(ctx); await renderProviders(ctx, id ?? undefined, "❌ Setup cancelled."); return true; }
  if (d === "provider:add") { const id = messageId(ctx); if (id === null) return true; pending = { step: "slot", messageId: id }; const k = new InlineKeyboard(); for (const c of CAPABILITIES.filter((x) => x !== "image")) k.row().text(LABEL[c], `provider:add:${c}`); k.row().text("🎨 Image AI", "provider:image:menu").row().text("❌ Cancel", "provider:cancel"); await ctx.api.editMessageText(chat, id, "➕ Add Provider\n\nChoose the capability first.", { reply_markup: k }); return true; }
  if (d.startsWith("provider:add:")) { const c = d.slice("provider:add:".length) as AiCapability; if (!CAPABILITIES.includes(c) || c === "image") return true; const id = messageId(ctx); if (id === null) return true; pending = { step: "name", capability: c, messageId: id }; await editWizard(ctx, id, `➕ Add ${LABEL[c]} Provider\n\n1/3 · Provider name`); return true; }
  if (d.startsWith("provider:slot:")) { const c = d.slice("provider:slot:".length) as AiCapability; const id = messageId(ctx); if (CAPABILITIES.includes(c)) await renderSlot(ctx, c, id ?? undefined); return true; }
  if (d === "provider:image:menu") { const id = messageId(ctx); await renderImage(ctx, id ?? undefined); return true; }
  if (d === "provider:image:cloudflare:configure") { const id = messageId(ctx); if (id === null) return true; pending = { step: "image-cloudflare-account", messageId: id }; await editWizard(ctx, id, "☁️ Cloudflare Workers AI\n\n1/2 · Send your Cloudflare Account ID\n\nIt must be the 32-character account ID.\n🔐 It will be verified before storage.", "provider:image:menu"); return true; }
  if (d === "provider:image:custom:configure") { const id = messageId(ctx); if (id === null) return true; pending = { step: "image-custom-base-url", messageId: id }; await editWizard(ctx, id, "🔌 Custom API\n\n1/4 · Base URL", "provider:image:menu"); return true; }
  if (d === "provider:image:remove") { clearProviderWizard(); await removeCloudflareCredentials(); await removeImageAiProvider(IMAGE_AI_PROVIDER_IDS.CUSTOM_ID); const id = messageId(ctx); await renderImage(ctx, id ?? undefined, "🗑️ Image AI provider configuration removed."); return true; }
  if (d === "provider:stt:groq:add") { const id = messageId(ctx); if (id !== null) { pending = { step: "groq-stt-key", messageId: id }; await editWizard(ctx, id, "🎤 Configure Groq Voice STT\n\nSend API key to verify."); } return true; }
  if (d === "provider:stt:groq:remove") { await removeGroqStt(); const id = messageId(ctx); await renderSlot(ctx, "stt", id ?? undefined, "🎤 Groq Voice STT disabled."); return true; }
  if (d.startsWith("provider:delete:")) { const deleted = await deleteCustomProvider(d.slice("provider:delete:".length)); if (deleted) { await restartOpenCodeAfterProviderChange(); const id = messageId(ctx); await renderProviders(ctx, id ?? undefined); } return true; }
  if (d.startsWith("provider:view:")) { const p = (await listCustomProviders()).find((x) => x.id === d.slice("provider:view:".length)); if (p) { const id = messageId(ctx); if (id !== null) await ctx.api.editMessageText(chat, id, `🔌 ${p.name}\n\nSlot: ${LABEL[p.capability]}\nBase URL: ${p.baseURL}\nModels:\n${p.models.map((m) => `• ${m.name} (${m.id})`).join("\n")}\n\n🔐 API key is never displayed.`, { reply_markup: new InlineKeyboard().text("← Slot", `provider:slot:${p.capability}`).text("✖ Close", "provider:close") }); } return true; }
  if (d === "provider:menu") { const id = messageId(ctx); await renderProviders(ctx, id ?? undefined); return true; }
  return true;
}

export async function handleProviderWizardMessage(ctx: Context): Promise<boolean> {
  const text = ctx.message?.text?.trim(); const s = pending; if (!ctx.chat?.id || !text || !s) return false;
  try {
    if (s.step === "image-cloudflare-account") { if (!/^[a-f0-9]{32}$/i.test(text)) { await deleteInput(ctx); await editWizard(ctx, s.messageId, "❌ Invalid Cloudflare Account ID. Send the 32-character Account ID again.", "provider:image:menu"); return true; } s.accountId = text; s.step = "image-cloudflare-token"; await deleteInput(ctx); await editWizard(ctx, s.messageId, "☁️ Cloudflare Workers AI\n\n2/2 · Send your API Token\n\n🔐 Token is never displayed or logged and is stored only after verification.", "provider:image:menu"); return true; }
    if (s.step === "image-cloudflare-token") { await deleteInput(ctx); await editWizard(ctx, s.messageId, "☁️ Verifying Cloudflare token + Account ID…", "provider:image:menu"); const result = await configureCloudflareCredentials(s.accountId!, text); if (!result.valid) throw new Error(`Cloudflare verification failed: ${result.reason}`); clearProviderWizard(); await renderImage(ctx, s.messageId, "✅ Cloudflare Workers AI verified and activated."); return true; }
    if (s.step === "image-custom-base-url") { s.baseURL = text.replace(/\/+$/g, ""); try { const u = new URL(s.baseURL); if (!["http:", "https:"].includes(u.protocol)) throw 0; } catch { await editWizard(ctx, s.messageId, "🔌 Invalid Base URL. Try again.", "provider:image:menu"); return true; } s.step = "image-custom-model"; await deleteInput(ctx); await editWizard(ctx, s.messageId, "🔌 Custom API\n\n2/4 · Generation model", "provider:image:menu"); return true; }
    if (s.step === "image-custom-model") { s.model = text; s.step = "image-custom-edit-model"; await deleteInput(ctx); await editWizard(ctx, s.messageId, "🔌 Custom API\n\n3/4 · Edit model or `none`", "provider:image:menu"); return true; }
    if (s.step === "image-custom-edit-model") { if (text.toLowerCase() !== "none") s.editModel = text; s.step = "image-custom-key"; await deleteInput(ctx); await editWizard(ctx, s.messageId, "🔌 Custom API\n\n4/4 · API key", "provider:image:menu"); return true; }
    if (s.step === "image-custom-key") { await deleteInput(ctx); await editWizard(ctx, s.messageId, "🔌 Verifying Custom API…", "provider:image:menu"); const options: { baseURL: string; model: string; editModel?: string } = { baseURL: s.baseURL!, model: s.model! }; if (s.editModel) options.editModel = s.editModel; await configureImageAiProvider(IMAGE_AI_PROVIDER_IDS.CUSTOM_ID, text, options); clearProviderWizard(); await renderImage(ctx, s.messageId, "✅ Custom API verified and activated."); return true; }
    if (s.step === "gemini-chat-key") { await deleteInput(ctx); await editWizard(ctx, s.messageId, "🤖 Verifying Gemini API key…"); const r = await fetch(`${GEMINI_BASE_URL}/models/${GEMINI_MODEL}`, { headers: { Authorization: `Bearer ${text}` }, signal: AbortSignal.timeout(15_000) }); if (!r.ok) throw new Error(`Gemini verification failed: HTTP ${r.status}`); await saveCustomProvider({ id: GEMINI_PROVIDER_ID, name: "Gemini", baseURL: GEMINI_BASE_URL, apiKey: text, models: [{ id: GEMINI_MODEL, name: "Gemini 3.1 Flash-Lite" }], capability: "coding" }); await deleteCustomProvider(LEGACY_GEMINI_IMAGE_PROVIDER_ID); clearProviderWizard(); await restartOpenCodeAfterProviderChange(); await renderProviders(ctx, s.messageId, "✅ Gemini verified and activated in 💻 Coding AI."); return true; }
    if (s.step === "groq-stt-key") { await deleteInput(ctx); await editWizard(ctx, s.messageId, "🎤 Verifying Groq…"); await configureGroqStt(text); clearProviderWizard(); await renderSlot(ctx, "stt", s.messageId, "✅ Groq Voice STT verified and activated."); return true; }
    if (s.step === "slot") return true;
    if (s.step === "name") { s.name = text; s.step = "url"; await deleteInput(ctx); await editWizard(ctx, s.messageId, `➕ Add ${LABEL[s.capability!]} Provider\n\n2/3 · Base URL`); return true; }
    if (s.step === "url") { const url = text.replace(/\/+$/g, ""); try { const u = new URL(url); if (!["http:", "https:"].includes(u.protocol)) throw 0; s.baseURL = url; } catch { await deleteInput(ctx); await editWizard(ctx, s.messageId, "⚠️ Invalid URL. Try again."); return true; } s.step = "key"; await deleteInput(ctx); await editWizard(ctx, s.messageId, "➕ Add Provider\n\n3/3 · API key"); return true; }
    await deleteInput(ctx); await editWizard(ctx, s.messageId, "🔎 Verifying provider and discovering models…"); const models = await discoverModels(s.baseURL!, text); const saved = await saveCustomProvider({ name: s.name!, baseURL: s.baseURL!, apiKey: text, models, capability: s.capability! }); clearProviderWizard(); await restartOpenCodeAfterProviderChange(); await renderSlot(ctx, s.capability!, s.messageId, `✅ ${saved.name} verified and activated in ${LABEL[s.capability!]}.\n${models.length} verified model${models.length === 1 ? "" : "s"}.`); return true;
  } catch (error) { logger.error("[Providers] Provider wizard failed:", error); const msg = error instanceof Error ? error.message : "Unknown error"; await editWizard(ctx, s.messageId, `❌ ${msg}\n\nThe credential was NOT saved. Try again or Cancel.`, s.step.startsWith("image-") ? "provider:image:menu" : "provider:menu").catch(() => {}); return true; }
}
