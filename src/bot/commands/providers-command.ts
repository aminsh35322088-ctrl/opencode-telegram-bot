import type { CommandContext, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { configureGroqStt, deleteCustomProvider, discoverModels, isGroqSttConfigured, removeGroqStt, listCustomProviders, saveCustomProvider, syncOpenCodeCustomConfig, type AiCapability } from "../../app/services/custom-provider-service.js";
import { configureCloudflareCredentials, configureImageAiProvider, IMAGE_AI_PROVIDER_IDS, listImageAiProviders, removeCloudflareCredentials, removeImageAiProvider } from "../../app/services/image-ai-provider-service.js";
import { reconcileStoredModelSelection } from "../../app/services/model-selection-service.js";
import { isChatModelMetadata, isImageModelMetadata } from "../../app/services/model-eligibility-service.js";
import { config } from "../../config.js";
import { findServerPid, killServerProcess, resolveLocalOpencodeTarget, startLocalOpencodeServer } from "../../opencode/process.js";
import { waitForOpencodeReadyAndRefresh } from "../../opencode/ready-refresh.js";
import { logger } from "../../utils/logger.js";
import { clearIntegrationWizard } from "./integrations-command.js";
import { buildSettingsMenuView } from "../menus/settings-menu.js";
import { appendHomeNavigation } from "../menus/inline-menu.js";
import { TopicScopedValue } from "../../app/services/topic-scoped-value.js";
import { setAiRoleSelection } from "../../app/services/ai-role-selection-service.js";
import { getMainNavigationMessageId, setDefaultCapabilityModel } from "../../app/stores/settings-store.js";

type Step = "name" | "url" | "key" | "groq-stt-key" | "stt-select" | "image-cloudflare-account" | "image-cloudflare-token" | "image-custom-base-url" | "image-custom-model" | "image-custom-edit-model" | "image-custom-key";
interface PendingProvider { step: Step; capability?: AiCapability; providerID?: string; name?: string; baseURL?: string; model?: string; editModel?: string; accountId?: string; messageId: number; expires: number; busy?: boolean; }
const providerWizard = new TopicScopedValue<PendingProvider>();
function messageId(ctx: Context): number | undefined { const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id; const canonical = typeof chatId === "number" ? getMainNavigationMessageId(chatId) : undefined; return canonical ?? ctx.callbackQuery?.message?.message_id; }
function wizardKeyboard() { return new InlineKeyboard().text("✖ Cancel", "provider:cancel"); }
export function isProviderWizardActive(): boolean { return providerWizard.isActive(); }
export function clearProviderWizard(): void { providerWizard.clear(); }
async function deleteInput(ctx: Context) { if (ctx.chat && ctx.message) await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {}); }
async function render(ctx: Context, text: string, keyboard: InlineKeyboard, id?: number) {
  const options = { reply_markup: appendHomeNavigation(keyboard) };
  const targetId = id ?? messageId(ctx);
  if (targetId !== undefined && ctx.chat) {
    try {
      await ctx.api.editMessageText(ctx.chat.id, targetId, text.slice(0, 4000), options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes("message is not modified")) throw error;
    }
  } else {
    await ctx.reply(text.slice(0, 4000), options);
  }
}
async function editWizard(ctx: Context, id: number, text: string) {
  const targetId = id ?? messageId(ctx);
  if (targetId !== undefined && ctx.chat) {
    try {
      await ctx.api.editMessageText(ctx.chat.id, targetId, text.slice(0, 4000), { reply_markup: wizardKeyboard() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes("message is not modified")) throw error;
    }
    return;
  }
  await ctx.reply(text.slice(0, 4000), { reply_markup: wizardKeyboard() });
}
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
    const refreshed = await waitForOpencodeReadyAndRefresh("provider_change");
    if (!refreshed) throw new Error("OpenCode did not become ready after provider restart.");
    return;
  }
  await reconcileStoredModelSelection({ forceCatalogRefresh: true });
}
async function applyAiChanges(): Promise<string> {
  try { await restartOpenCodeAfterProviderChange(); return ""; }
  catch { logger.warn("[Providers] Settings saved, but OpenCode refresh failed"); return "\n⚠️ Settings are saved. OpenCode could not reload them; restart the bot to apply."; }
}
function compactButtonLabel(value: string, max = 42): string {
  return value.length <= max ? value : value.slice(0, Math.max(1, max - 1)) + "…";
}
async function renderImageProviders(ctx: Context, id?: number, notice = "") {
  const legacy = await listImageAiProviders();
  const cloudflare = legacy.find((provider) => provider.id === IMAGE_AI_PROVIDER_IDS.CLOUDFLARE_ID);
  const oldCustom = legacy.find((provider) => provider.id === IMAGE_AI_PROVIDER_IDS.CUSTOM_ID);
  const keyboard = new InlineKeyboard()
    .text(cloudflare ? "☁️ Cloudflare Workers AI · Connected" : "☁️ Configure Cloudflare Workers AI", "provider:image:cloudflare:configure").row()
    .text(oldCustom ? "🖼 OpenAI-compatible Image API · Connected" : "🖼 Add OpenAI-compatible Image API", "provider:image:custom:configure").row();

  if (cloudflare) keyboard.text("🗑 Remove Cloudflare", "provider:remove-image:cloudflare").row();
  if (oldCustom) keyboard.text("🗑 Remove OpenAI-compatible Image API", "provider:remove-image:custom").row();
  keyboard.text("← API Connections", "provider:menu");

  await render(ctx, [
    notice,
    "🎨 Image APIs",
    "",
    "Image-only adapters live here.",
    "Multi-purpose APIs belong in API Connections and are classified automatically from their model catalog.",
    "",
    cloudflare ? "Cloudflare Workers AI · Connected" : "Cloudflare Workers AI · Not configured",
    oldCustom ? "Legacy Custom Image API · Connected" : "",
  ].filter(Boolean).join("\n"), keyboard, id);
}

async function renderSlot(ctx: Context, capability: AiCapability, id?: number, notice = "") {
  if (capability !== "stt") {
    await renderProviders(ctx, id, notice);
    return;
  }

  const providers = (await listCustomProviders()).filter((provider) => provider.capability === "stt");
  const groq = await isGroqSttConfigured();
  const keyboard = new InlineKeyboard();

  for (const provider of providers) {
    keyboard.text(compactButtonLabel("🎙 " + provider.name + " · " + provider.models.length + " models"), "provider:view:" + provider.id).row();
  }

  keyboard.text("➕ Add Transcription API", "provider:add:stt").row();
  keyboard.text(groq ? "🎤 Groq · Connected" : "🎤 Configure Groq", "provider:stt:groq:add").row();
  if (groq) keyboard.text("🗑 Remove Groq", "provider:stt:groq:remove").row();
  keyboard.text("← API Connections", "provider:menu");

  await render(ctx, [
    notice,
    "🎙 Transcription APIs",
    "",
    "Connections used specifically for Voice → Text.",
    "Choose the default transcription model later in Settings → Default Model Center.",
    "",
    providers.length + " custom transcription API" + (providers.length === 1 ? "" : "s"),
    "Groq · " + (groq ? "Connected" : "Not configured"),
  ].filter(Boolean).join("\n"), keyboard, id);
}

async function renderProviders(ctx: Context, id?: number, notice = "") {
  const [providers, legacy, groq] = await Promise.all([listCustomProviders(), listImageAiProviders(), isGroqSttConfigured()]);
  const general = providers.filter((provider) => provider.capability !== "stt");
  const transcription = groq || providers.some((provider) => provider.capability === "stt");
  const imageAdapters = legacy.filter((provider) =>
    provider.id === IMAGE_AI_PROVIDER_IDS.CLOUDFLARE_ID || provider.id === IMAGE_AI_PROVIDER_IDS.CUSTOM_ID
  ).length;
  const keyboard = new InlineKeyboard();

  for (const provider of general) {
    keyboard.text(compactButtonLabel("🔌 " + provider.name + " · " + provider.models.length + " models"), "provider:view:" + provider.id).row();
  }

  keyboard.text("➕ Add Provider", "provider:add:general").row();
  keyboard.text("🎙 Transcription · " + (transcription ? "Configured" : "Not set"), "provider:slot:stt").row();
  keyboard.text("🎨 Image APIs · " + (imageAdapters ? imageAdapters + " connected" : "Optional"), "provider:image:engines").row();
  keyboard.text("← Settings", "provider:settings");

  await render(ctx, [
    notice,
    "🔌 API Connections",
    "",
    "Connect and manage model APIs in one place.",
    "Model selection stays separate under Settings → Default Model Center.",
    "",
    general.length + " AI provider" + (general.length === 1 ? "" : "s") + " connected",
    "Transcription · " + (transcription ? "Configured" : "Not configured"),
  ].filter(Boolean).join("\n"), keyboard, id);
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
  if (data === "provider:connections") { await renderProviders(ctx, id); return true; }
  if (["provider:settings", "provider:advanced", "provider:close"].includes(data)) {
    const view = buildSettingsMenuView(); await render(ctx, view.text.replace(/<[^>]*>/g, ""), view.keyboard, id); return true;
  }
  if (data.startsWith("provider:slot:")) {
    const raw = data.slice("provider:slot:".length) as AiCapability;
    const capability: AiCapability = raw === "stt" ? "stt" : "general";
    await renderSlot(ctx, capability, id);
    return true;
  }
  if (data === "provider:image:engines") { await renderImageProviders(ctx, id); return true; }
  if (data.startsWith("provider:add:")) {
    const capability = data.slice("provider:add:".length) as AiCapability;
    if (capability === "general" || capability === "coding" || capability === "image" || capability === "stt") await start(ctx, "name", capability === "stt" ? "🎙 Add Transcription API\n\nStep 1 of 3 — Name\n\nSend a short name for this API connection.\nExample: My API" : "🔌 Add Provider\n\nStep 1 of 3 — Name\n\nSend a short name for this API connection.\nExample: My API", capability === "stt" ? "stt" : "general"); return true;
  }
  if (data === "provider:image:cloudflare:configure") { await start(ctx, "image-cloudflare-account", "☁️ Cloudflare Workers AI\n\nStep 1 of 2 · Account ID\nSend your Cloudflare Account ID."); return true; }
  if (data === "provider:image:custom:configure") { await start(ctx, "image-custom-base-url", "🖼 OpenAI Image API\n\nStep 1 of 4 · Base URL\nPaste the image API base URL.\n\nExample: https://api.example.com/v1"); return true; }
  if (data === "provider:stt:groq:add") { await start(ctx, "groq-stt-key", "🎤 Groq Transcription\n\nAPI key\nSend your Groq API key.\n\n🔒 Your key message will be deleted immediately.", "stt"); return true; }
  if (data === "provider:stt:groq:remove") { await removeGroqStt(); await renderSlot(ctx, "stt", id, "✅ Groq removed.\n\n"); return true; }
  if (data.startsWith("provider:stt:")) {
    const p = (await listCustomProviders()).find(p => p.id === data.slice("provider:stt:".length) && p.capability === "stt");
    if (p) { const examples = p.models.slice(0, 8).map(m => "• " + m.id).join("\n"); await start(ctx, "stt-select", `🎙 ${p.name}\n\nTranscription model\nSend the exact model ID.${examples ? "\n\nExamples:\n" + examples : ""}`, "stt"); const wizard = providerWizard.get(); if (wizard) wizard.providerID = p.id; }
    return true;
  }
  if (data.startsWith("provider:remove-image:") || data === "provider:image:cloudflare:remove" || data === "provider:image:custom:remove") {
    const type = data.includes("cloudflare") ? "cloudflare" : "custom";
    await render(ctx, "Remove this image connection?\n\nAny Image AI default or Topic override using it will become unavailable.", new InlineKeyboard().text("🗑 Remove", `provider:confirm-image:${type}`).text("Cancel", "provider:image:engines"), id); return true;
  }
  if (data === "provider:confirm-image:cloudflare" || data === "provider:confirm-image:custom") {
    if (data.endsWith(":cloudflare")) await removeCloudflareCredentials(); else await removeImageAiProvider(IMAGE_AI_PROVIDER_IDS.CUSTOM_ID);
    await renderImageProviders(ctx, id, "✅ Connection removed.\n\n"); return true;
  }
  if (data.startsWith("provider:delete:")) {
    const providerID = data.slice("provider:delete:".length);
    await render(ctx, "Remove this provider?\n\nAny selected default or Topic override using it will become unavailable.", new InlineKeyboard().text("🗑 Remove", `provider:rm:${providerID}`).text("Cancel", `provider:view:${providerID}`), id); return true;
  }
  if (data.startsWith("provider:rm:")) {
    const providerID = data.slice("provider:rm:".length);
    const p = (await listCustomProviders()).find(p => p.id === providerID);
    if (p && await deleteCustomProvider(providerID)) {
      const notice = p.capability === "stt" ? "" : await applyAiChanges();
      if (p.capability === "stt") await renderSlot(ctx, "stt", id, `✅ Connection removed.${notice}\n\n`); else await renderProviders(ctx, id, `✅ Connection removed.${notice}\n\n`);
    }
    return true;
  }
  if (data.startsWith("provider:view:")) {
    const p = (await listCustomProviders()).find(p => p.id === data.slice("provider:view:".length));
    if (p?.capability === "stt") {
      await render(ctx, `🎙 ${p.name}\n\nConnected transcription API\nModels · ${p.models.length}\n\nChoose the Voice → Text model used by this connection.`, new InlineKeyboard().text("🎙 Choose model", `provider:stt:${p.id}`).row().text("🗑 Remove Provider", `provider:delete:${p.id}`).row().text("← Transcription APIs", "provider:slot:stt"), id); return true;
    }
    if (p) {
      const chat = p.models.filter(isChatModelMetadata).length;
      const image = p.models.filter(isImageModelMetadata).length;
      const text = "🔌 " + p.name + "\n\nConnected\nEndpoint · " + p.baseURL
        + "\nModels · " + p.models.length
        + "\nChat / Coding · " + chat + "\nImage-capable · " + image
        + "\n\nChoose defaults under Settings → Default Model Center.";
      await render(ctx, text, new InlineKeyboard().text("🗑 Remove Provider", "provider:delete:" + p.id).row().text("← API Connections", "provider:menu"), id);
    }
    return true;
  }
  await renderProviders(ctx, id); return true;
}
export async function handleProviderWizardMessage(ctx: Context): Promise<boolean> {
  const text = ctx.message?.text?.trim(), s = providerWizard.get();
  if (!ctx.chat || !text || !s) return false;
  if (text.startsWith("/") || text === "❌ Cancel" || text === "✖ Cancel") { clearProviderWizard(); return false; }
  if (Date.now() > s.expires) {
    await deleteInput(ctx);
    clearProviderWizard();
    await renderProviders(ctx, s.messageId, "⌛ Setup expired.\n\n");
    return true;
  }
  if (s.busy) {
    await deleteInput(ctx);
    await editWizard(ctx, s.messageId, "🔎 Checking connection\n\nVerification is already running.\nWait for it to finish, or tap Cancel.");
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
    if (s.step === "name") { s.name = text; s.step = "url"; await editWizard(ctx, s.messageId, `${s.capability === "stt" ? "🎙 Add Transcription API" : "🔌 Add Provider"}\n\nStep 2 of 3 — Base URL\n\nSend the API base URL.\nExample: https://api.example.com/v1\n\nUse the API root only — do not include /models or /chat/completions.`); return true; }
    if (s.step === "url" || s.step === "image-custom-base-url") {
      let url: URL;
      try { url = new URL(text); } catch { throw new Error("Enter a valid HTTP(S) base URL."); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Use a base URL without embedded credentials, query parameters, or fragments.");
      s.baseURL = text.replace(/\/+$/g, ""); s.step = s.step === "url" ? "key" : "image-custom-model";
      await editWizard(ctx, s.messageId, s.step === "key" ? `${s.capability === "stt" ? "🎙 Add Transcription API" : "🔌 Add Provider"}\n\nStep 3 of 3 — API Key\n\nSend the API key.\nYour key message is removed from the chat after it is read.` : "🎨 Configure Image API\n\nStep 2 of 4 — Generation model\n\nSend the generation model ID."); return true;
    }
    if (s.step === "image-cloudflare-account") {
      if (!/^[a-f0-9]{32}$/i.test(text)) throw new Error("Account ID must contain 32 hexadecimal characters");
      s.accountId = text; s.step = "image-cloudflare-token"; await editWizard(ctx, s.messageId, "🎨 Configure Image API\n\nStep 2 of 2 — API Token\n\nSend the Cloudflare API token.\nYour token message is removed from the chat after it is read."); return true;
    }
    if (s.step === "image-custom-model") { s.model = text; s.step = "image-custom-edit-model"; await editWizard(ctx, s.messageId, "🖼 OpenAI Image API\n\nStep 3 of 4 · Edit model\nSend the edit model ID."); return true; }
    if (s.step === "image-custom-edit-model") { s.editModel = text; s.step = "image-custom-key"; await editWizard(ctx, s.messageId, "🖼 OpenAI Image API\n\nStep 4 of 4 · API key\nSend the key.\n\n🔒 Your key message will be deleted immediately."); return true; }
    s.busy = true; await editWizard(ctx, s.messageId, "🔎 Connecting…\n\nChecking credentials and reading the model catalog.");
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
    if (s.step.startsWith("image-")) await renderImageProviders(ctx, s.messageId, "✅ Connection saved.\n\n");
    else await renderSlot(ctx, s.capability === "stt" ? "stt" : "general", s.messageId, `✅ Provider saved.${notice}\n\n`);
  } catch (error) {
    if (providerWizard.get() !== s) return true;
    s.busy = false;
    logger.warn(`[Providers] Setup failed at ${s.step}; saved=${saved}`);
    const message = error instanceof Error ? error.message : "Connection verification failed";
    await editWizard(ctx, s.messageId, `❌ Couldn’t complete setup\n\n${message}\n\n${saved ? "The connection was saved. Tap Cancel to return to API Connections." : "Send the value again, or tap Cancel."}`).catch(() => {});
  }
  return true;
}
