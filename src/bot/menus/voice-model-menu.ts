import { randomBytes } from "node:crypto";
import { InlineKeyboard, type Context } from "grammy";
import { listUnifiedModelCatalog } from "../../app/services/unified-model-catalog-service.js";
import { setAiRoleSelection } from "../../app/services/ai-role-selection-service.js";
import {
  getCurrentTopicCapabilityOverride,
  getCurrentTopicSettings,
  getDefaultCapabilityModel,
  setCurrentTopicCapabilityOverride,
  setDefaultCapabilityModel,
} from "../../app/stores/settings-store.js";
import type { ModelRef } from "../../app/types/model-capability.js";
import { SETTINGS_BACK_CALLBACK, SETTINGS_DEFAULT_MODELS_CALLBACK, SETTINGS_VOICE_MODEL_CALLBACK } from "./settings-menu.js";

const PICK_PREFIX = SETTINGS_VOICE_MODEL_CALLBACK + ":pick:";
const RESET_CALLBACK = SETTINGS_VOICE_MODEL_CALLBACK + ":reset";
const CLEAR_DEFAULT_CALLBACK = SETTINGS_VOICE_MODEL_CALLBACK + ":clear";
const MANAGE_CONNECTIONS_CALLBACK = "provider:connections";
const CHOICE_TTL_MS = 15 * 60_000;
const choices = new Map<string, { scope: string; ref: ModelRef; expiresAt: number }>();

function html(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
function scope(ctx: Context): string {
  const message = ctx.callbackQuery?.message ?? ctx.message;
  const threadID = message && "message_thread_id" in message ? message.message_thread_id ?? 0 : 0;
  return `${ctx.chat?.id ?? "unknown"}:${threadID > 1 ? threadID : 0}`;
}
function token(ctx: Context, ref: ModelRef): string {
  const id = randomBytes(8).toString("hex");
  choices.set(id, { scope: scope(ctx), ref, expiresAt: Date.now() + CHOICE_TTL_MS });
  while (choices.size > 200) choices.delete(choices.keys().next().value!);
  return PICK_PREFIX + id;
}
function same(left: ModelRef | undefined, right: ModelRef): boolean { return left?.providerID === right.providerID && left.modelID === right.modelID; }
function format(ref: ModelRef | undefined): string { return ref ? `${html(ref.providerID)}/${html(ref.modelID)}` : "Not configured"; }

export async function buildVoiceModelSettingsView(ctx: Context, notice = ""): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const models = (await listUnifiedModelCatalog()).filter((entry) => entry.capabilities.operations.speechToText === true);
  const topic = getCurrentTopicSettings();
  const override = getCurrentTopicCapabilityOverride("speechToText");
  const mainDefault = getDefaultCapabilityModel("speechToText");
  const keyboard = new InlineKeyboard();

  if (topic && override) keyboard.text("↩️ Auto · Primary / Main Default", RESET_CALLBACK).row();
  if (!topic && mainDefault) keyboard.text("✖ Clear Main Default", CLEAR_DEFAULT_CALLBACK).row();
  for (const entry of models.slice(0, 60)) {
    const ref = { providerID: entry.providerID, modelID: entry.modelID };
    const selected = same(topic ? override : mainDefault, ref);
    keyboard.text(`${selected ? "✅" : "🎙️"} ${entry.providerName} · ${entry.modelName}${selected ? " ✓" : ""}`, token(ctx, ref)).row();
  }
  keyboard.text("🔌 Manage AI providers", MANAGE_CONNECTIONS_CALLBACK).row();
  keyboard.text(topic ? "← Topic Model Center" : "← Default Models", topic ? SETTINGS_BACK_CALLBACK : SETTINGS_DEFAULT_MODELS_CALLBACK);

  const current = topic ? (override ? `${format(override)} · Topic Override` : `Auto · Primary native audio when supported, otherwise ${format(mainDefault)}`) : format(mainDefault);
  return {
    text: [notice, "🎙️ <b>Voice → Text</b>", "", `Current · ${current}`, "", topic
      ? "Auto uses the Primary model natively when it accepts audio; otherwise it uses the Main Default STT helper. Choose a model here to force a Topic override even when Primary audio is available."
      : "Choose the Main Default transcription helper used only when a Topic Primary cannot accept audio natively.", "", models.length ? "Only models with confirmed speech-to-text support are listed." : "No connected model currently has confirmed speech-to-text support."].filter(Boolean).join("\n"),
    keyboard,
  };
}

export async function handleVoiceModelSettingsCallback(ctx: Context, data: string): Promise<boolean> {
  if (data === SETTINGS_VOICE_MODEL_CALLBACK) {
    await ctx.answerCallbackQuery().catch(() => {});
    const view = await buildVoiceModelSettingsView(ctx);
    await ctx.editMessageText(view.text, { parse_mode: "HTML", reply_markup: view.keyboard });
    return true;
  }
  if (data === RESET_CALLBACK) {
    setCurrentTopicCapabilityOverride("speechToText", undefined);
    await ctx.answerCallbackQuery({ text: "Voice routing set to Auto" }).catch(() => {});
    const view = await buildVoiceModelSettingsView(ctx, "✅ Topic Voice routing now uses Auto.\n");
    await ctx.editMessageText(view.text, { parse_mode: "HTML", reply_markup: view.keyboard });
    return true;
  }
  if (data === CLEAR_DEFAULT_CALLBACK) {
    setDefaultCapabilityModel("speechToText", undefined);
    await ctx.answerCallbackQuery({ text: "Main Default cleared" }).catch(() => {});
    const view = await buildVoiceModelSettingsView(ctx, "✅ Main Default Voice → Text cleared.\n");
    await ctx.editMessageText(view.text, { parse_mode: "HTML", reply_markup: view.keyboard });
    return true;
  }
  if (!data.startsWith(PICK_PREFIX)) return false;
  const selected = choices.get(data.slice(PICK_PREFIX.length));
  choices.delete(data.slice(PICK_PREFIX.length));
  if (!selected || selected.scope !== scope(ctx) || selected.expiresAt < Date.now()) {
    await ctx.answerCallbackQuery({ text: "This model selection expired. Reopen the menu.", show_alert: true });
    return true;
  }
  const available = (await listUnifiedModelCatalog()).some((entry) => entry.providerID === selected.ref.providerID && entry.modelID === selected.ref.modelID && entry.capabilities.operations.speechToText === true);
  if (!available) {
    await ctx.answerCallbackQuery({ text: "This Voice → Text model is no longer available.", show_alert: true });
    return true;
  }
  if (getCurrentTopicSettings()) setCurrentTopicCapabilityOverride("speechToText", selected.ref);
  else {
    setDefaultCapabilityModel("speechToText", selected.ref);
    await setAiRoleSelection("stt", selected.ref.providerID, selected.ref.modelID);
  }
  await ctx.answerCallbackQuery({ text: "Voice → Text model saved" }).catch(() => {});
  const view = await buildVoiceModelSettingsView(ctx, "✅ Voice → Text model saved.\n");
  await ctx.editMessageText(view.text, { parse_mode: "HTML", reply_markup: view.keyboard });
  return true;
}

export function clearVoiceModelMenuChoices(): void { choices.clear(); }
