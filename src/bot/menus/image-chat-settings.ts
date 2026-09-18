import { randomBytes } from "node:crypto";
import { InlineKeyboard, type Context } from "grammy";
import {
  getDefaultImageChatImageProviderID,
  getDefaultImageChatProfile,
  getImageChatDefaultMode,
  setDefaultImageChatImageProviderID,
  setDefaultImageChatProfile,
  setImageChatDefaultMode,
} from "../../app/stores/image-chat-store.js";
import {
  buildToolImageChatProfile,
  configureGeminiImageConnection,
  hasGeminiImageConnection,
  removeGeminiImageConnection,
  imageConnectionUsage,
  rankAutoImageChatModels,
  GEMINI_IMAGE_CONNECTION,
} from "../../app/services/image-chat-profile-service.js";
import { listCustomProviders } from "../../app/services/custom-provider-service.js";
import { getActiveImageAiProviders } from "../../app/services/image-ai-provider-service.js";
import { isChatModelMetadata } from "../../app/services/model-eligibility-service.js";

const DEFAULT_MODELS_BACK_CALLBACK = "settings:default_models";
type WizardStep = "gemini-model" | "gemini-key" | "tool-model" | "image-provider";
interface Wizard {
  step: WizardStep;
  modelID?: string;
  connectionID?: string;
  messageID?: number;
  expires: number;
  busy?: boolean;
}
type ChoiceKind = "connection" | "model" | "image";
interface Choice { scope: string; id: string; kind: ChoiceKind; expires: number; }
const wizards = new Map<string, Wizard>();
const choices = new Map<string, Choice>();

function scope(ctx: Context): string {
  const msg = ctx.message ?? ctx.callbackQuery?.message;
  const thread = msg && "message_thread_id" in msg ? msg.message_thread_id ?? 0 : 0;
  return `${ctx.chat?.id}:${thread > 1 ? thread : 0}`;
}
function currentMessageID(ctx: Context): number | undefined { return ctx.callbackQuery?.message?.message_id; }
function cancelKeyboard(): InlineKeyboard { return new InlineKeyboard().text("← Image Chat", "icfg:root"); }
function choice(ctx: Context, kind: ChoiceKind, id: string): string {
  const token = randomBytes(8).toString("hex");
  choices.set(token, { scope: scope(ctx), id, kind, expires: Date.now() + 15 * 60_000 });
  while (choices.size > 200) choices.delete(choices.keys().next().value!);
  return `icfg:pick:${token}`;
}
function start(ctx: Context, step: WizardStep): Wizard {
  const value: Wizard = { step, messageID: currentMessageID(ctx), expires: Date.now() + 15 * 60_000 };
  wizards.set(scope(ctx), value);
  while (wizards.size > 20) wizards.delete(wizards.keys().next().value!);
  return value;
}
async function render(ctx: Context, text: string, keyboard: InlineKeyboard, messageID?: number): Promise<void> {
  const id = messageID ?? currentMessageID(ctx);
  if (ctx.chat && id !== undefined) {
    await ctx.api.editMessageText(ctx.chat.id, id, text.slice(0, 4000), { reply_markup: keyboard });
    return;
  }
  await ctx.reply(text.slice(0, 4000), { reply_markup: keyboard });
}
async function activeImageProviders() {
  return (await getActiveImageAiProviders()).filter((provider) => provider.capabilities.includes("generate") && provider.capabilities.includes("edit"));
}
async function preferredImageProviderID(): Promise<string | undefined> {
  const [preferred, profile, providers] = await Promise.all([
    getDefaultImageChatImageProviderID(),
    getDefaultImageChatProfile(),
    activeImageProviders(),
  ]);
  return providers.find((provider) => provider.id === preferred)?.id
    ?? (profile?.mode === "tools" ? providers.find((provider) => provider.id === profile.imageProviderID)?.id : undefined)
    ?? providers[0]?.id;
}
async function saveManualToolProfile(ctx: Context, connectionID: string, modelID: string, imageProviderID: string, messageID?: number): Promise<void> {
  const profile = await buildToolImageChatProfile(connectionID, modelID, imageProviderID);
  await setDefaultImageChatProfile(profile);
  await setDefaultImageChatImageProviderID(imageProviderID);
  await setImageChatDefaultMode("manual");
  clearImageChatSetup(ctx);
  await showImageChatSettings(ctx, { messageID, notice: "✅ Manual defaults saved.\n\n" });
}

export function clearImageChatSetup(ctx: Context): void { wizards.delete(scope(ctx)); }

export async function showImageChatSettings(ctx: Context, options: { messageID?: number; notice?: string } = {}): Promise<void> {
  clearImageChatSetup(ctx);
  const [profile, mode, providers, imageProviders, selectedImageID] = await Promise.all([
    getDefaultImageChatProfile(),
    getImageChatDefaultMode(),
    listCustomProviders(),
    activeImageProviders(),
    preferredImageProviderID(),
  ]);
  const autoCandidate = rankAutoImageChatModels(providers)[0];
  const selectedImage = imageProviders.find((provider) => provider.id === selectedImageID);
  const manualChat = profile?.mode === "tools" ? `${profile.connectionID} / ${profile.modelID}` : profile?.mode === "gemini" ? `Gemini / ${profile.modelID}` : "Not configured";
  const imageModel = profile?.mode === "gemini" && mode === "manual"
    ? `Gemini unified / ${profile.modelID}`
    : selectedImage ? `${selectedImage.name} / ${selectedImage.model}` : "Not configured";
  const autoStatus = autoCandidate ? `${autoCandidate.family} → ${autoCandidate.modelID}` : "No confirmed free vision model found";
  const keyboard = new InlineKeyboard()
    .text(`${mode === "auto" ? "✅" : "🤖"} Auto · Free planner`, "icfg:mode:auto").row()
    .text(`${mode === "manual" ? "✅" : "🛠"} Manual`, "icfg:mode:manual").row()
    .text("🧠 Select chat model", "icfg:chat-model").row()
    .text("🎨 Select image model", "icfg:image-model").row()
    .text("✨ Gemini unified model", "icfg:gemini").row()
    .text("🔌 Manage image connections", "provider:image:engines").row()
    .text("← Default Models", DEFAULT_MODELS_BACK_CALLBACK);
  await render(ctx, `${options.notice ?? ""}🎨 Image Chat Defaults\n\nMode: ${mode === "auto" ? "🤖 Auto" : "🛠 Manual"}\n\nAuto chat planner: ${autoStatus}\nManual chat model: ${manualChat}\nImage model: ${imageModel}\n\nAuto changes only the conversation/vision planner and only uses confirmed free OpenRouter routes. The image generator/editor remains your independent default. Existing Image Chat Topics stay pinned until you start a new design with current defaults.`, keyboard, options.messageID);
}

async function showConversationConnections(ctx: Context): Promise<void> {
  clearImageChatSetup(ctx);
  const providers = (await listCustomProviders()).filter((provider) => provider.capability !== "stt" && provider.models.some((model) => isChatModelMetadata(model) && (model.modalities?.input?.includes("image") || model.attachment === true)));
  const keyboard = new InlineKeyboard();
  for (const provider of providers) keyboard.text(provider.name, choice(ctx, "connection", provider.id)).row();
  keyboard.text("← Image Chat", "icfg:root");
  await render(ctx, providers.length ? "🧠 Manual chat model\n\nChoose a vision-capable chat connection." : "No vision-capable chat connection is configured. Connect OpenRouter or another compatible provider first.", keyboard);
}
async function showImageProviderChoices(ctx: Context, wizard?: Wizard): Promise<void> {
  const providers = await activeImageProviders();
  const keyboard = new InlineKeyboard();
  for (const provider of providers) keyboard.text(`${provider.name} · ${provider.model}`, choice(ctx, "image", provider.id)).row();
  keyboard.text("← Image Chat", "icfg:root");
  await render(ctx, providers.length ? "🎨 Image model\n\nChoose the default generator/editor." : "No image generator with generation + editing support is configured.", keyboard, wizard?.messageID);
}

export async function handleImageChatSetup(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (data?.startsWith("icfg:")) {
    await ctx.answerCallbackQuery().catch(() => {});
    if (data === "icfg:root") { await showImageChatSettings(ctx); return true; }
    if (data === "icfg:mode:auto") {
      await setImageChatDefaultMode("auto");
      await showImageChatSettings(ctx, { notice: "✅ Auto is now the default for new Image Chats.\n\n" });
      return true;
    }
    if (data === "icfg:mode:manual") {
      await setImageChatDefaultMode("manual");
      await showImageChatSettings(ctx, { notice: "✅ Manual mode selected. Choose models below if needed.\n\n" });
      return true;
    }
    if (data === "icfg:chat-model" || data === "icfg:tools") { await showConversationConnections(ctx); return true; }
    if (data === "icfg:image-model") {
      const wizard = start(ctx, "image-provider");
      await showImageProviderChoices(ctx, wizard);
      return true;
    }
    if (data === "icfg:remove-gemini") {
      clearImageChatSetup(ctx);
      await render(ctx, `Remove the Gemini image key? ${await imageConnectionUsage(GEMINI_IMAGE_CONNECTION)} Image Chat/default selections depend on it.`, new InlineKeyboard().text("Remove", "icfg:confirm-remove-gemini").text("Cancel", "icfg:root"));
      return true;
    }
    if (data === "icfg:confirm-remove-gemini") { clearImageChatSetup(ctx); await removeGeminiImageConnection(); await showImageChatSettings(ctx); return true; }
    if (data === "icfg:gemini") {
      const wizard = start(ctx, "gemini-model");
      const keyboard = cancelKeyboard();
      if (await hasGeminiImageConnection()) keyboard.row().text("Remove Gemini connection", "icfg:remove-gemini");
      await render(ctx, "✨ Gemini unified model\n\nSend the exact Gemini image model ID. It must support generateContent and image output/editing.", keyboard, wizard.messageID);
      return true;
    }
    if (data.startsWith("icfg:pick:")) {
      const option = choices.get(data.slice("icfg:pick:".length));
      if (!option || option.scope !== scope(ctx) || option.expires < Date.now()) { await render(ctx, "This selection expired. Reopen Image Chat defaults.", cancelKeyboard()); return true; }
      choices.delete(data.slice("icfg:pick:".length));
      if (option.kind === "connection") {
        const wizard = start(ctx, "tool-model"); wizard.connectionID = option.id;
        const provider = (await listCustomProviders()).find((item) => item.id === option.id);
        const models = provider?.models.filter((model) => isChatModelMetadata(model) && (model.modalities?.input?.includes("image") || model.attachment === true)).slice(0, 25) ?? [];
        const keyboard = new InlineKeyboard();
        for (const model of models) keyboard.text(model.name || model.id, choice(ctx, "model", model.id)).row();
        keyboard.text("← Image Chat", "icfg:root");
        await render(ctx, models.length ? `🧠 ${provider?.name ?? "Chat model"}\n\nChoose the conversation/vision model.` : "This provider has no confirmed vision-capable chat model.", keyboard, wizard.messageID);
        return true;
      }
      if (option.kind === "model") {
        const wizard = wizards.get(scope(ctx));
        if (!wizard || wizard.step !== "tool-model" || !wizard.connectionID || wizard.expires < Date.now()) { await showImageChatSettings(ctx, { notice: "Selection expired. Reopen manual model selection.\n\n" }); return true; }
        wizard.modelID = option.id;
        const imageProviderID = await preferredImageProviderID();
        if (!imageProviderID) {
          wizard.step = "image-provider";
          await showImageProviderChoices(ctx, wizard);
          return true;
        }
        await saveManualToolProfile(ctx, wizard.connectionID, option.id, imageProviderID, wizard.messageID);
        return true;
      }
      const imageProviderID = option.id;
      await setDefaultImageChatImageProviderID(imageProviderID);
      const wizard = wizards.get(scope(ctx));
      const profile = await getDefaultImageChatProfile();
      const mode = await getImageChatDefaultMode();
      const connectionID = wizard?.connectionID ?? (profile?.mode === "tools" ? profile.connectionID : undefined);
      const modelID = wizard?.modelID ?? (profile?.mode === "tools" ? profile.modelID : undefined);
      if (mode === "manual" && connectionID && modelID) {
        await saveManualToolProfile(ctx, connectionID, modelID, imageProviderID, wizard?.messageID);
      } else {
        const messageID = wizard?.messageID;
        clearImageChatSetup(ctx);
        await showImageChatSettings(ctx, { messageID, notice: "✅ Image model saved.\n\n" });
      }
      return true;
    }
    return true;
  }

  // Any callback navigation away invalidates a pending secret/text wizard.
  if (data) { clearImageChatSetup(ctx); return false; }
  const wizard = wizards.get(scope(ctx)), text = ctx.message?.text?.trim();
  if (!wizard || !text) return false;
  if (wizard.expires < Date.now()) { clearImageChatSetup(ctx); await ctx.reply("Setup expired. Reopen Image Chat defaults."); return true; }
  if (text.startsWith("/") || text === "❌ Cancel" || text.startsWith("⚙️") || text === "💬 New Chat" || text === "🎨 New Image Chat" || text === "🕘 History") { clearImageChatSetup(ctx); return false; }
  if (wizard.busy) { await ctx.reply("Verification is still running. Use Back to cancel."); return true; }
  if (ctx.chat && ctx.message) await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
  try {
    if (wizard.step === "gemini-model") {
      if (!/^[a-zA-Z0-9._-]{1,100}$/.test(text)) throw new Error("Invalid model ID");
      wizard.modelID = text; wizard.step = "gemini-key";
      await render(ctx, "Send your Gemini API key. Access is verified before saving; setup itself does not generate an image.", cancelKeyboard(), wizard.messageID);
      return true;
    }
    if (wizard.step === "gemini-key") {
      wizard.busy = true;
      const profile = await configureGeminiImageConnection(text, wizard.modelID!, () => { if (wizards.get(scope(ctx)) !== wizard) throw new Error("Setup cancelled"); });
      if (wizards.get(scope(ctx)) !== wizard) return true;
      await setDefaultImageChatProfile(profile);
      await setImageChatDefaultMode("manual");
      const messageID = wizard.messageID;
      clearImageChatSetup(ctx);
      await showImageChatSettings(ctx, { messageID, notice: "✅ Gemini manual default saved.\n\n" });
      return true;
    }
    await render(ctx, "Use the model buttons in Image Chat defaults.", cancelKeyboard(), wizard.messageID);
  } catch (error) {
    wizard.busy = false;
    await render(ctx, error instanceof Error ? error.message : "Setup failed", cancelKeyboard(), wizard.messageID);
  }
  return true;
}