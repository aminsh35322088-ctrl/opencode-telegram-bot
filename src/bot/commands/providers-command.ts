import type { CommandContext, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { configureGroqStt, deleteCustomProvider, discoverModels, isGroqSttConfigured, removeGroqStt, listCustomProviders, saveCustomProvider, syncOpenCodeCustomConfig, type AiCapability } from "../../app/services/custom-provider-service.js";
import { configureCloudflareCredentials, configureImageAiProvider, IMAGE_AI_PROVIDER_IDS, listImageAiProviders, removeCloudflareCredentials, removeImageAiProvider } from "../../app/services/image-ai-provider-service.js";
import { imageConnectionUsage } from "../../app/services/image-chat-profile-service.js";
import { reconcileStoredModelSelection } from "../../app/services/model-selection-service.js";
import { isChatModelMetadata, isImageModelMetadata } from "../../app/services/model-eligibility-service.js";
import { config } from "../../config.js";
import { findServerPid, killServerProcess, resolveLocalOpencodeTarget, startLocalOpencodeServer } from "../../opencode/process.js";
import { logger } from "../../utils/logger.js";
import { clearIntegrationWizard } from "./integrations-command.js";
import { buildSettingsMenuView } from "../menus/settings-menu.js";
import { showImageChatSettings } from "../menus/image-chat-settings.js";
import { appendHomeNavigation } from "../menus/inline-menu.js";
import { TopicScopedValue } from "../../app/services/topic-scoped-value.js";
import { setAiRoleSelection } from "../../app/services/ai-role-selection-service.js";
import { setDefaultCapabilityModel } from "../../app/stores/settings-store.js";

const CAPABILITIES: AiCapability[] = ["general", "stt"];
const LABEL: Record<AiCapability, string> = { general: "🤖 AI Models", coding: "🤖 AI Models", image: "🤖 AI Models", stt: "🎙️ Transcription" };
type Step = "name" | "url" | "key" | "groq-stt-key" | "stt-select" | "image-cloudflare-account" | "image-cloudflare-token" | "image-custom-base-url" | "image-custom-model" | "image-custom-edit-model" | "image-custom-key";
interface PendingProvider { step: Step; capability?: AiCapability; providerID?: string; name?: string; baseURL?: string; model?: string; editModel?: string; accountId?: string; messageId: number; expires: number; busy?: boolean; }
const providerWizard = new TopicScopedValue<PendingProvider>();
function messageId(ctx: Context): number | undefined { return ctx.callbackQuery?.message?.message_id; }
function wizardKeyboard() { return new InlineKeyboard().text("❌ Cancel", "provider:cancel").text("← Connections", "provider:connections"); }
export function isProviderWizardActive(): boolean { return providerWizard.isActive(); }
export function clearProviderWizard(): void { providerWizard.clear(); }
async function deleteInput(ctx: Context) { if (ctx.chat && ctx.message) await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {}); }
async function render(ctx: Context, text: string, keyboard: InlineKeyboard, id?: number) {
  const options = { reply_markup: appendHomeNavigation(keyboard) };
  if (id !== undefined && ctx.chat) await ctx.api.editMessageText(ctx.chat.id, id, text.slice(0, 4000), options);
  else await ctx.reply(text.slice(0, 4000), options);
}
async function editWizard(ctx: Context, id: number, text: string) { await render(ctx, text, wizardKeyboard(), id); }
async function start(ctx: Context, step: Step, text: string, capability?: AiCapability): Promise<void> {
  const id = messageId(ctx); if (id === undefined) return;
  providerWizard.set({ step, capability, messageId: id, expires: Date.now() + 15 * 60_000 });
  await editWizard(ctx, id, text);
}
async function restartOpenCodeAfterProviderChange(): Promise<void> {
  const configPath = await syncOpenCodeCustomConfig(); process.env.OPENCODE_CONFIG = configPath;
  const target = resolveLocalOpencodeTarget(config.opencode.apiUrl);
  if (target) {
    const pid = await findServerPid(target.port); if (pid) await killServerProcess(pid);
    await new Promise(r => setTimeout(r, 500)); startLocalOpencodeServer(target).unref();
  }
  await reconcileStoredModelSelection({ forceCatalogRefresh: true });
}
async function applyAiChanges(): Promise<string> {
  try { await restartOpenCodeAfterProviderChange(); return ""; }
  catch { logger.warn("[Providers] Settings saved, but OpenCode refresh failed"); return "\n⚠️ Settings are saved. OpenCode could not reload them; restart the bot to apply."; }
}
async function renderAiProviders(ctx: Context, id?: number, notice = "") {
  const [providers, legacy] = await Promise.all([listCustomProviders(), listImageAiProviders()]);
  const general = providers.filter((provider) => provider.capability !== "stt");
  const cloudflare = legacy.find((provider) => provider.id === IMAGE_AI_PROVIDER_IDS.CLOUDFLARE_ID);
  const oldCustom = legacy.find((provider) => provider.id === IMAGE_AI_PROVIDER_IDS.CUSTOM_ID);
  const keyboard = new InlineKeyboard();

  for (const provider of general) {
    const chat = provider.models.filter(isChatModelMetadata).length;
    const image = provider.models.filter(isImageModelMetadata).length;
    keyboard.text("🔌 " + provider.name + " · 💬" + chat + " 🎨" + image, "provider:view:" + provider.id).row();
  }

  keyboard.text("➕ Add AI Provider", "provider:add:general").row();
  keyboard.text("☁️ Cloudflare Workers AI" + (cloudflare ? " · Configured" : ""), "provider:image:cloudflare:configure").row();
  if (cloudflare) keyboard.text("Remove Cloudflare", "provider:remove-image:cloudflare").row();
  if (oldCustom) keyboard.text("Remove Legacy Custom Image API", "provider:remove-image:custom").row();
  keyboard.text("← Connections", "provider:connections");

  await render(ctx, [
    notice,
    "🤖 AI Providers",
    "",
    "Add one API connection. Each discovered model is classified automatically:",
    "• text output → Primary / Chat & Coding",
    "• image output → Image AI",
    "• one provider may appear in both",
    "",
    general.length + " custom AI connection" + (general.length === 1 ? "" : "s"),
    cloudflare ? "Cloudflare legacy image adapter: configured" : "Cloudflare legacy image adapter: not configured",
  ].filter(Boolean).join("\n"), keyboard, id);
}

async function renderSlot(ctx: Context, capability: AiCapability, id?: number, notice = "") {
  if (capability !== "stt") {
    await renderAiProviders(ctx, id, notice);
    return;
  }

  const providers = (await listCustomProviders()).filter((provider) => provider.capability === "stt");
  const keyboard = new InlineKeyboard();
  for (const provider of providers) keyboard.text("🔌 " + provider.name, "provider:view:" + provider.id).row();
  keyboard.text("➕ Add Transcription API", "provider:add:stt").row();
  keyboard.text("🎤 Groq · Configure key", "provider:stt:groq:add").row();
  if (await isGroqSttConfigured()) keyboard.text("Remove Groq", "provider:stt:groq:remove").row();
  keyboard.text("← Connections", "provider:connections");
  await render(ctx, notice + "🎙️ Transcription connections\n\nVoice transcription stays separate because it uses a different request contract.", keyboard, id);
}

async function renderConnections(ctx: Context, id?: number, notice = "") {
  const keyboard = new InlineKeyboard()
    .text("🤖 AI Providers", "provider:slot:general").row()
    .text("🎙️ Transcription", "provider:slot:stt").row()
    .text("← AI Providers", "provider:menu");
  await render(ctx, notice + "🔌 Manage Connections\n\nAI providers are model-centric: no manual Chat/Image provider split. Model capabilities decide where each model appears.", keyboard, id);
}

async function renderProviders(ctx: Context, id?: number, notice = "") {
  const [providers, legacy, groq] = await Promise.all([listCustomProviders(), listImageAiProviders(), isGroqSttConfigured()]);
  const aiConnections = providers.filter((provider) => provider.capability !== "stt").length
    + legacy.filter((provider) => provider.id === IMAGE_AI_PROVIDER_IDS.CLOUDFLARE_ID).length;
  const transcription = groq || providers.some((provider) => provider.capability === "stt");
  const keyboard = new InlineKeyboard()
    .text("🔌 Manage Connections", "provider:connections").row()
    .text("← Settings", "provider:settings");
  await render(ctx, notice + "🔌 AI Providers\n\n" + aiConnections + " AI connection" + (aiConnections === 1 ? "" : "s")
    + "\nTranscription: " + (transcription ? "Configured" : "Not configured")
    + "\n\nProvider setup stores connections and model catalogs. Defaults are selected under Settings → Default Models.", keyboard, id);
}
export async function providersCommand(ctx: CommandContext<Context>) {
  clearProviderWizard(); clearIntegrationWizard(); await renderProviders(ctx);
}
export async function handleProviderCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? ""; if (!data.startsWith("provider:") || !ctx.chat) return false;
  clearProviderWizard(); clearIntegrationWizard();
  await ctx.answerCallbackQuery().catch(() => {});
  const id = messageId(ctx);
  if (["provider:menu", "provider:cancel", "provider:add"].includes(data)) { await renderProviders(ctx, id); return true; }
  if (data === "provider:connections") { await renderConnections(ctx, id); return true; }
  if (["provider:settings", "provider:advanced", "provider:close"].includes(data)) {
    const view = buildSettingsMenuView(); await render(ctx, view.text.replace(/<[^>]*>/g, ""), view.keyboard, id); return true;
  }
  if (data.startsWith("provider:slot:")) {
    const raw = data.slice("provider:slot:".length) as AiCapability;
    const capability: AiCapability = raw === "stt" ? "stt" : "general";
    if (CAPABILITIES.includes(capability)) await renderSlot(ctx, capability, id);
    return true;
  }
  if (data === "provider:image:menu") { await showImageChatSettings(ctx); return true; }
  if (data === "provider:image:engines") { await renderAiProviders(ctx, id); return true; }
  if (data.startsWith("provider:add:")) {
    const capability = data.slice("provider:add:".length) as AiCapability;
    if (capability === "general" || capability === "coding" || capability === "image" || capability === "stt") await start(ctx, "name", `Add ${LABEL[capability]} provider\n\n1/3 · Provider name`, capability); return true;
  }
  if (data === "provider:image:cloudflare:configure") { await start(ctx, "image-cloudflare-account", "Cloudflare Workers AI\n\n1/2 · Send the 32-character Account ID"); return true; }
  if (data === "provider:image:custom:configure") { await start(ctx, "name", "Add AI provider\n\n1/3 · Provider name", "general"); return true; }
  if (data === "provider:stt:groq:add") { await start(ctx, "groq-stt-key", "Groq transcription\n\nSend the API key to verify.", "stt"); return true; }
  if (data === "provider:stt:groq:remove") { await removeGroqStt(); await renderSlot(ctx, "stt", id, "✅ Groq removed.\n\n"); return true; }
  if (data.startsWith("provider:stt:")) {
    const p = (await listCustomProviders()).find(p => p.id === data.slice("provider:stt:".length) && p.capability === "stt");
    if (p) { await start(ctx, "stt-select", `Send the exact transcription model ID from ${p.name}.\n\n${p.models.slice(0, 20).map(m => m.id).join("\n")}`, "stt"); const wizard = providerWizard.get(); if (wizard) wizard.providerID = p.id; }
    return true;
  }
  if (data.startsWith("provider:remove-image:") || data === "provider:image:cloudflare:remove" || data === "provider:image:custom:remove") {
    const type = data.includes("cloudflare") ? "cloudflare" : "custom";
    const usage = await imageConnectionUsage(type === "cloudflare" ? IMAGE_AI_PROVIDER_IDS.CLOUDFLARE_ID : IMAGE_AI_PROVIDER_IDS.CUSTOM_ID);
    await render(ctx, `Remove this image connection?\n\n${usage} Image Chat/default selections depend on it and will become unavailable.`, new InlineKeyboard().text("Remove", `provider:confirm-image:${type}`).text("Cancel", "provider:slot:general"), id); return true;
  }
  if (data === "provider:confirm-image:cloudflare" || data === "provider:confirm-image:custom") {
    if (data.endsWith(":cloudflare")) await removeCloudflareCredentials(); else await removeImageAiProvider(IMAGE_AI_PROVIDER_IDS.CUSTOM_ID);
    await renderAiProviders(ctx, id, "✅ Connection removed.\n\n"); return true;
  }
  if (data.startsWith("provider:delete:")) {
    const providerID = data.slice("provider:delete:".length), usage = await imageConnectionUsage(providerID);
    await render(ctx, `Remove this provider?\n\n${usage} Image Chat/default selections also depend on it.`, new InlineKeyboard().text("Remove", `provider:rm:${providerID}`).text("Cancel", "provider:connections"), id); return true;
  }
  if (data.startsWith("provider:rm:")) {
    const providerID = data.slice("provider:rm:".length);
    const p = (await listCustomProviders()).find(p => p.id === providerID);
    if (p && await deleteCustomProvider(providerID)) {
      const notice = p.capability === "stt" ? "" : await applyAiChanges();
      await renderConnections(ctx, id, `✅ Connection removed.${notice}\n\n`);
    }
    return true;
  }
  if (data.startsWith("provider:view:")) {
    const p = (await listCustomProviders()).find(p => p.id === data.slice("provider:view:".length));
    if (p?.capability === "stt") {
      await render(ctx, `${p.name}\n\nSelect the transcription model used by voice messages.`, new InlineKeyboard().text("Choose model", `provider:stt:${p.id}`).row().text("Remove", `provider:delete:${p.id}`).text("← Back", "provider:slot:stt"), id); return true;
    }
    if (p) {
      const chat = p.models.filter(isChatModelMetadata).length;
      const image = p.models.filter(isImageModelMetadata).length;
      const text = "🔌 " + p.name + "\n\nAI model catalog\n" + p.baseURL
        + "\n" + p.models.length + " discovered models"
        + "\n💬 Chat/Coding: " + chat + "\n🎨 Image output: " + image
        + "\n\n" + p.models.slice(0, 20).map((model) => model.id).join("\n");
      await render(ctx, text, new InlineKeyboard().text("Remove", "provider:delete:" + p.id).text("← Back", "provider:slot:general"), id);
    }
    return true;
  }
  await renderProviders(ctx, id); return true;
}
export async function handleProviderWizardMessage(ctx: Context): Promise<boolean> {
  const text = ctx.message?.text?.trim(), s = providerWizard.get();
  if (!ctx.chat || !text || !s) return false;
  if (text.startsWith("/") || text === "❌ Cancel") { clearProviderWizard(); return false; }
  if (Date.now() > s.expires) {
    await deleteInput(ctx);
    clearProviderWizard();
    await renderProviders(ctx, s.messageId, "⌛ Setup expired. Reopen AI Providers.\n\n");
    return true;
  }
  if (s.busy) {
    await deleteInput(ctx);
    await editWizard(ctx, s.messageId, "🔎 Verification is already running.\n\nWait for it to finish or press Back.");
    return true;
  }
  await deleteInput(ctx);
  let saved = false;
  const guard = () => { if (providerWizard.get() !== s || Date.now() > s.expires) throw new DOMException("Setup cancelled", "AbortError"); };
  try {
    if (s.step === "stt-select") {
      const p = (await listCustomProviders()).find(p => p.id === s.providerID && p.capability === "stt");
      if (!p?.models.some(m => m.id === text)) throw new Error("Choose a model returned by this transcription provider");
      guard(); await setAiRoleSelection("stt", p.id, text); setDefaultCapabilityModel("speechToText", { providerID: p.id, modelID: text }); clearProviderWizard(); await renderSlot(ctx, "stt", s.messageId, `✅ Transcription model: ${text}\n\n`); return true;
    }
    if (s.step === "name") { s.name = text; s.step = "url"; await editWizard(ctx, s.messageId, "2/3 · Base URL"); return true; }
    if (s.step === "url" || s.step === "image-custom-base-url") {
      const url = new URL(text); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Enter an HTTP(S) base URL without embedded credentials, query or fragment");
      s.baseURL = text.replace(/\/+$/g, ""); s.step = s.step === "url" ? "key" : "image-custom-model";
      await editWizard(ctx, s.messageId, s.step === "key" ? "3/3 · API key" : "2/4 · Generation model ID"); return true;
    }
    if (s.step === "image-cloudflare-account") {
      if (!/^[a-f0-9]{32}$/i.test(text)) throw new Error("Account ID must contain 32 hexadecimal characters");
      s.accountId = text; s.step = "image-cloudflare-token"; await editWizard(ctx, s.messageId, "2/2 · Cloudflare API token"); return true;
    }
    if (s.step === "image-custom-model") { s.model = text; s.step = "image-custom-edit-model"; await editWizard(ctx, s.messageId, "3/4 · Edit model ID (required for Image Chat)"); return true; }
    if (s.step === "image-custom-edit-model") { s.editModel = text; s.step = "image-custom-key"; await editWizard(ctx, s.messageId, "4/4 · API key"); return true; }
    s.busy = true; await editWizard(ctx, s.messageId, "🔎 Verifying credentials and model access…");
    if (s.step === "image-cloudflare-token") {
      const validation = await configureCloudflareCredentials(s.accountId!, text, guard);
      if (!validation.valid) throw new Error(`Cloudflare verification failed: ${validation.reason}`);
    } else if (s.step === "image-custom-key") await configureImageAiProvider(IMAGE_AI_PROVIDER_IDS.CUSTOM_ID, text, { baseURL: s.baseURL!, model: s.model!, editModel: s.editModel! }, guard);
    else if (s.step === "groq-stt-key") { await configureGroqStt(text, guard); saved = true; await setAiRoleSelection("stt", "groq", "whisper-large-v3"); setDefaultCapabilityModel("speechToText", { providerID: "groq", modelID: "whisper-large-v3" }); }
    else {
      const models = await discoverModels(s.baseURL!, text); guard();
      await saveCustomProvider({ name: s.name!, baseURL: s.baseURL!, apiKey: text, models, capability: s.capability === "stt" ? "stt" : "general", beforeSave: guard });
    }
    saved = true;
    const notice = s.capability === "stt" ? "" : await applyAiChanges();
    if (providerWizard.get() !== s) return true;
    clearProviderWizard();
    if (s.step.startsWith("image-")) await renderAiProviders(ctx, s.messageId, "✅ Credentials and model access verified.\n\n");
    else await renderSlot(ctx, s.capability === "stt" ? "stt" : "general", s.messageId, `✅ Provider saved.${notice}\n\n`);
  } catch (error) {
    if (providerWizard.get() !== s) return true;
    s.busy = false;
    logger.warn(`[Providers] Setup failed at ${s.step}; saved=${saved}`);
    const message = error instanceof Error && error.name !== "TypeError" ? error.message : "Connection verification failed";
    await editWizard(ctx, s.messageId, `❌ ${message}\n\n${saved ? "The credential is saved. Reopen AI Providers." : "The credential was not saved. Try again or Cancel."}`).catch(() => {});
  }
  return true;
}
