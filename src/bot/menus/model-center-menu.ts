import { createHash } from "node:crypto";
import { InlineKeyboard } from "grammy";
import { getFavoriteModels, getRecentModels, isFavoriteModel } from "../../app/services/model-preferences-service.js";
import { getProviderModels, getProviders, searchModels } from "../../app/services/model-selection-service.js";
import type { FavoriteModel, ModelInfo, ProviderInfo } from "../../app/types/model.js";

export const MODEL_CENTER_CALLBACK_PREFIX = "mc:";
export const MODEL_CENTER_ROOT = "mc:root";
export const MODEL_CENTER_FAVORITES = "mc:favorites";
export const MODEL_CENTER_RECENT = "mc:recent";
export const MODEL_CENTER_PROVIDERS = "mc:providers";
export const MODEL_CENTER_SEARCH = "mc:search";
export const MODEL_CENTER_PROVIDER_PREFIX = "mc:provider:";
export const MODEL_CENTER_SELECT_PREFIX = "mc:select:";
export const MODEL_CENTER_FAVORITE_PREFIX = "mc:favorite:";

const actionModels = new Map<string, ModelInfo>();

function modelKey(model: FavoriteModel | ModelInfo): string { return `${model.providerID}/${model.modelID}`; }
function actionToken(model: ModelInfo): string {
  const token = createHash("sha256").update(`${modelKey(model)}:${model.variant ?? "default"}`).digest("base64url").slice(0, 10);
  actionModels.set(token, { providerID: model.providerID, modelID: model.modelID, variant: model.variant ?? "default" });
  return token;
}
export function resolveModelCenterAction(token: string): ModelInfo | null { return actionModels.get(token) ?? null; }

function modelButtonLabel(model: FavoriteModel | ModelInfo, active: boolean): string {
  const marker = active ? "🟢" : "🧠";
  return `${marker} ${model.modelID}\n${model.providerID}`;
}

async function appendModelRows(keyboard: InlineKeyboard, models: FavoriteModel[], current?: ModelInfo): Promise<void> {
  for (const model of models) {
    const info = { providerID: model.providerID, modelID: model.modelID, variant: "default" } satisfies ModelInfo;
    const token = actionToken(info);
    const favorite = await isFavoriteModel(model);
    keyboard.text(modelButtonLabel(model, !!current && modelKey(current) === modelKey(model)), `${MODEL_CENTER_SELECT_PREFIX}${token}`);
    keyboard.text(favorite ? "⭐" : "☆", `${MODEL_CENTER_FAVORITE_PREFIX}${token}`).row();
  }
}

export async function buildModelCenterRoot(current?: ModelInfo): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const favorites = await getFavoriteModels();
  const recent = await getRecentModels();
  const keyboard = new InlineKeyboard();
  keyboard.text(`⭐ Favorites · ${favorites.length}`, MODEL_CENTER_FAVORITES).text(`🕘 Recent models · ${recent.length}`, MODEL_CENTER_RECENT).row();
  keyboard.text("🔎 Search models", MODEL_CENTER_SEARCH).row();
  keyboard.text("🧩 Browse providers", MODEL_CENTER_PROVIDERS).row();
  keyboard.text("← Back", "model:settings_back");
  const currentBlock = current?.providerID && current.modelID
    ? `🟢 <b>CURRENT MODEL</b>\n<code>${escapeHtml(current.modelID)}</code>\n${escapeHtml(current.providerID)}`
    : "🟢 <b>CURRENT MODEL</b>\nNo model selected";
  const text = ["🤖 <b>MODEL CENTER</b>", "", currentBlock, "", "Select a model, manage favorites, or browse the live provider catalog."].join("\n");
  return { text, keyboard };
}

export async function buildModelCenterList(kind: "favorites" | "recent", current?: ModelInfo): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const models = kind === "favorites" ? await getFavoriteModels() : await getRecentModels();
  const keyboard = new InlineKeyboard();
  await appendModelRows(keyboard, models, current);
  keyboard.text("← Model Center", MODEL_CENTER_ROOT);
  const title = kind === "favorites" ? "⭐ <b>FAVORITE MODELS</b>" : "🕘 <b>RECENT MODELS</b>";
  const text = models.length ? `${title}\n\nSelect a model or tap ⭐ to change favorites.` : `${title}\n\nNo models here yet.`;
  return { text, keyboard };
}

export async function buildModelCenterProviders(): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const providers = await getProviders();
  const keyboard = new InlineKeyboard();
  providers.forEach((provider) => keyboard.text(`🧩 ${provider.name} · ${provider.modelCount} models`, `${MODEL_CENTER_PROVIDER_PREFIX}${encodeURIComponent(provider.id)}`).row());
  keyboard.text("← Model Center", MODEL_CENTER_ROOT);
  return { text: providers.length ? "🧩 <b>PROVIDERS</b>\n\nLive model catalog from every available provider." : "🧩 <b>PROVIDERS</b>\n\nNo providers are currently available.", keyboard };
}

export async function buildModelCenterProvider(provider: ProviderInfo, current?: ModelInfo): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const models = await getProviderModels(provider.id);
  const keyboard = new InlineKeyboard();
  await appendModelRows(keyboard, models, current);
  keyboard.text("← Providers", MODEL_CENTER_PROVIDERS).row();
  keyboard.text("← Model Center", MODEL_CENTER_ROOT);
  return { text: `🧩 <b>${escapeHtml(provider.name)}</b>\n\n${models.length} live models. Tap a model to select it or ☆/⭐ to manage favorites.`, keyboard };
}

export async function searchModelCenter(query: string, current?: ModelInfo): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const models = await searchModels(query);
  const keyboard = new InlineKeyboard();
  await appendModelRows(keyboard, models, current);
  keyboard.text("← Model Center", MODEL_CENTER_ROOT);
  return { text: models.length ? `🔎 <b>SEARCH</b> · <code>${escapeHtml(query)}</code>` : `🔎 <b>SEARCH</b>\n\nNo models matched <code>${escapeHtml(query)}</code>.`, keyboard };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
