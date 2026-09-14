import { randomBytes } from "node:crypto";
import { InlineKeyboard, type Context } from "grammy";
import { getDefaultImageChatProfile, setDefaultImageChatProfile } from "../../app/stores/image-chat-store.js";
import { buildToolImageChatProfile, configureGeminiImageConnection, hasGeminiImageConnection, removeGeminiImageConnection, imageConnectionUsage, GEMINI_IMAGE_CONNECTION } from "../../app/services/image-chat-profile-service.js";
import { listCustomProviders } from "../../app/services/custom-provider-service.js";
import { getActiveImageAiProviders } from "../../app/services/image-ai-provider-service.js";
import { isChatModelMetadata } from "../../app/services/model-eligibility-service.js";

interface Wizard { step: "gemini-model" | "gemini-key" | "tool-model" | "image-provider"; modelID?: string; connectionID?: string; expires: number; busy?: boolean }
const wizards = new Map<string, Wizard>();
const choices = new Map<string, { scope: string; id: string; kind: "connection" | "image"; expires: number }>();
function scope(ctx: Context): string { const msg = ctx.message ?? ctx.callbackQuery?.message; const thread = msg && "message_thread_id" in msg ? msg.message_thread_id ?? 0 : 0; return `${ctx.chat?.id}:${thread > 1 ? thread : 0}`; }
function cancelKeyboard(): InlineKeyboard { return new InlineKeyboard().text("← Image settings", "icfg:root"); }
function choice(ctx: Context, kind: "connection" | "image", id: string): string {
  const token = randomBytes(8).toString("hex"); choices.set(token, { scope: scope(ctx), id, kind, expires: Date.now() + 15 * 60_000 });
  if (choices.size > 100) choices.delete(choices.keys().next().value!);
  return `icfg:pick:${token}`;
}
function start(ctx: Context, step: Wizard["step"]): Wizard {
  const value: Wizard = { step, expires: Date.now() + 15 * 60_000 }; wizards.set(scope(ctx), value);
  if (wizards.size > 20) wizards.delete(wizards.keys().next().value!);
  return value;
}
export function clearImageChatSetup(ctx: Context): void { wizards.delete(scope(ctx)); }
export async function showImageChatSettings(ctx: Context): Promise<void> {
  clearImageChatSetup(ctx);
  const profile = await getDefaultImageChatProfile();
  if (await hasGeminiImageConnection()) await ctx.reply("Gemini image connection is configured.", { reply_markup: new InlineKeyboard().text("Remove Gemini connection", "icfg:remove-gemini") });
  await ctx.reply(`🎨 Image Chat\n\n${profile ? `Default: ${profile.modelID}\n${profile.mode === "gemini" ? "One model for conversation and images" : "Conversation model with an image tool"}` : "Choose how new Image Chats create and edit images."}\n\nChanges apply to new Image Chats. Existing Topics keep their selection.`, { reply_markup: new InlineKeyboard().text("🧠 Connect Gemini image model", "icfg:gemini").row().text("🔧 Use conversation + image tool", "icfg:tools").row().text("🔌 Image generators", "provider:image:engines").row().text("← AI Providers", "provider:menu") });
}
export async function handleImageChatSetup(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (data?.startsWith("icfg:")) {
    await ctx.answerCallbackQuery().catch(() => {});
    if (data === "icfg:root") { await showImageChatSettings(ctx); return true; }
    if (data === "icfg:remove-gemini") { clearImageChatSetup(ctx); await ctx.reply(`Remove the Gemini image key? ${await imageConnectionUsage(GEMINI_IMAGE_CONNECTION)} Image Chat/default selections depend on it.`, { reply_markup: new InlineKeyboard().text("Remove", "icfg:confirm-remove-gemini").text("Cancel", "icfg:root") }); return true; }
    if (data === "icfg:confirm-remove-gemini") { clearImageChatSetup(ctx); await removeGeminiImageConnection(); await showImageChatSettings(ctx); return true; }
    if (data === "icfg:gemini") {
      start(ctx, "gemini-model");
      await ctx.reply("Enter the exact Gemini image model ID. Use a model that supports text, image output and conversational editing.", { reply_markup: cancelKeyboard() }); return true;
    }
    if (data === "icfg:tools") {
      clearImageChatSetup(ctx);
      const providers = (await listCustomProviders()).filter(p => p.capability === "coding" && p.models.some(m => isChatModelMetadata(m) && (m.modalities?.input?.includes("image") || m.attachment === true)));
      const keyboard = new InlineKeyboard();
      for (const p of providers) keyboard.text(p.name, choice(ctx, "connection", p.id)).row();
      keyboard.text("← Image settings", "icfg:root");
      await ctx.reply(providers.length ? "Choose a conversation connection with vision support." : "Connect a vision-capable chat model under AI Providers → Chat & Coding first. Model metadata must confirm image input.", { reply_markup: keyboard }); return true;
    }
    if (data.startsWith("icfg:pick:")) {
      const option = choices.get(data.slice("icfg:pick:".length));
      if (!option || option.scope !== scope(ctx) || option.expires < Date.now()) { await ctx.reply("This selection expired. Reopen Image settings."); return true; }
      if (option.kind === "connection") {
        const wizard = start(ctx, "tool-model"); wizard.connectionID = option.id;
        const p = (await listCustomProviders()).find(p => p.id === option.id);
        const names = p?.models.filter(m => isChatModelMetadata(m) && (m.modalities?.input?.includes("image") || m.attachment === true)).slice(0, 15).map(m => m.id).join("\n");
        await ctx.reply(`Send the exact conversation model ID.\n\n${names ?? "Connection is unavailable"}`, { reply_markup: cancelKeyboard() });
      } else {
        const wizard = wizards.get(scope(ctx)); if (!wizard || wizard.step !== "image-provider" || wizard.expires < Date.now()) return true;
        try {
          const profile = await buildToolImageChatProfile(wizard.connectionID!, wizard.modelID!, option.id);
          if (wizards.get(scope(ctx)) !== wizard) return true;
          await setDefaultImageChatProfile(profile); clearImageChatSetup(ctx);
          await ctx.reply("✅ Default Image Chat settings saved."); await showImageChatSettings(ctx);
        } catch (error) { await ctx.reply(error instanceof Error ? error.message : "Could not save image settings"); }
      }
    }
    return true;
  }
  // Any navigation away invalidates the key wizard before another handler runs.
  if (data) { clearImageChatSetup(ctx); return false; }
  const wizard = wizards.get(scope(ctx)), text = ctx.message?.text?.trim();
  if (!wizard || !text) return false;
  if (wizard.expires < Date.now()) { clearImageChatSetup(ctx); await ctx.reply("Setup expired. Reopen Image settings."); return true; }
  if (text.startsWith("/") || text === "❌ Cancel" || text.startsWith("⚙️") || text === "💬 New Chat" || text === "🎨 New Image Chat" || text === "🕘 History") { clearImageChatSetup(ctx); return false; }
  if (wizard.busy) { await ctx.reply("Verification is still running. Wait or go back."); return true; }
  if (ctx.chat && ctx.message) await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
  try {
    if (wizard.step === "gemini-model") {
      if (!/^[a-zA-Z0-9._-]{1,100}$/.test(text)) throw new Error("Invalid model ID");
      wizard.modelID = text; wizard.step = "gemini-key";
      await ctx.reply("Send your Gemini API key. Model access will be checked before saving. No image is generated during setup.", { reply_markup: cancelKeyboard() }); return true;
    }
    if (wizard.step === "gemini-key") {
      wizard.busy = true;
      const profile = await configureGeminiImageConnection(text, wizard.modelID!, () => { if (wizards.get(scope(ctx)) !== wizard) throw new Error("Setup cancelled"); });
      if (wizards.get(scope(ctx)) !== wizard) return true;
      await setDefaultImageChatProfile(profile); clearImageChatSetup(ctx);
      await ctx.reply("✅ Key and model access checked. Image Chat settings saved; actual image support is checked when you use the model."); await showImageChatSettings(ctx); return true;
    }
    if (wizard.step === "tool-model") {
      wizard.modelID = text; wizard.step = "image-provider";
      const providers = (await getActiveImageAiProviders()).filter(p => p.capabilities.includes("generate") && p.capabilities.includes("edit"));
      const keyboard = new InlineKeyboard(); for (const p of providers) keyboard.text(`${p.name} · ${p.model}`, choice(ctx, "image", p.id)).row();
      keyboard.text("← Image settings", "icfg:root");
      await ctx.reply(providers.length ? "Choose the image generator/editor." : "Configure an image generator with editing support first.", { reply_markup: keyboard }); return true;
    }
    await ctx.reply("Choose an image connection using the buttons above.");
  } catch (error) { wizard.busy = false; await ctx.reply(error instanceof Error ? error.message : "Setup failed", { reply_markup: cancelKeyboard() }); }
  return true;
}
