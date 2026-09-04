import { createHash } from "node:crypto";
import { InlineKeyboard } from "grammy";
import { getFavoriteModels, getRecentModels } from "../../app/services/model-preferences-service.js";
import { fetchCurrentModel, getProviderModels, getProviders, searchModels } from "../../app/services/model-selection-service.js";
import { refreshAllCustomProviderModels } from "../../app/services/model-catalog-refresh-service.js";
import { formatModelName, type FavoriteModel, type ModelInfo, type ProviderInfo } from "../../app/types/model.js";
import type { Context } from "grammy";
import { replyWithInlineMenu } from "./inline-menu.js";

export const MODEL_CENTER_ROOT = "mc:root";
export const MODEL_CENTER_FAVORITES = "mc:favorites";
export const MODEL_CENTER_RECENT = "mc:recent";
export const MODEL_CENTER_PROVIDERS = "mc:providers";
export const MODEL_CENTER_SEARCH = "mc:search";
export const MODEL_CENTER_SEARCH_AGAIN = "mc:search:again";
export const MODEL_CENTER_SEARCH_CANCEL = "mc:search:cancel";
export const MODEL_CENTER_SETTINGS_BACK = "mc:settings_back";
export const MODEL_CENTER_PROVIDER_PREFIX = "mc:provider:";
export const MODEL_CENTER_SELECT_PREFIX = "mc:select:";
export const MODEL_CENTER_FAVORITE_PREFIX = "mc:favorite:";

const MODELS_PER_PAGE = 8;
const MAX_ACTION_MODELS = 4096;
const SEARCH_RESULTS_LIMIT = 10;
const actionModels = new Map<string, ModelInfo>();

function modelKey(model: FavoriteModel | ModelInfo): string {
  return `${model.providerID}/${model.modelID}`;
}

function actionToken(model: ModelInfo): string {
  const token = createHash("sha256")
    .update(`${modelKey(model)}:${model.variant ?? "default"}`)
    .digest("base64url")
    .slice(0, 10);
  actionModels.delete(token);
  actionModels.set(token, {
    providerID: model.providerID,
    modelID: model.modelID,
    name: model.name,
    variant: model.variant ?? "default",
  });
  while (actionModels.size > MAX_ACTION_MODELS) {
    const oldest = actionModels.keys().next().value as string | undefined;
    if (!oldest) break;
    actionModels.delete(oldest);
  }
  return token;
}

export function resolveModelCenterAction(token: string): ModelInfo | null {
  return actionModels.get(token) ?? null;
}

function modelButtonLabel(model: FavoriteModel | ModelInfo, active: boolean, favorite: boolean): string {
  const marker = favorite ? " ⭐" : "";
  const icon = active ? "🟢" : "🧠";
  return `${icon} ${formatModelName(model.modelID, model.name)}${marker}`;
}

async function appendModelRows(
  keyboard: InlineKeyboard,
  models: FavoriteModel[],
  current?: ModelInfo,
): Promise<void> {
  const favorites = await getFavoriteModels();
  const favoriteKeys = new Set(favorites.map(modelKey));

  for (const model of models) {
    const info: ModelInfo = {
      providerID: model.providerID,
      modelID: model.modelID,
      name: model.name,
      variant: "default",
    };
    const token = actionToken(info);
    const favorite = favoriteKeys.has(modelKey(model));
    const active = !!current && modelKey(current) === modelKey(model);

    keyboard.text(modelButtonLabel(model, active, favorite), `${MODEL_CENTER_SELECT_PREFIX}${token}`);
    keyboard.text(favorite ? "⭐" : "☆", `${MODEL_CENTER_FAVORITE_PREFIX}${token}`).row();
  }
}

function appendPagination(keyboard: InlineKeyboard, page: number, totalPages: number, callback: (page: number) => string): void {
  if (totalPages <= 1) return;
  if (page > 0) keyboard.text("‹ Prev", callback(page - 1));
  if (page < totalPages - 1) keyboard.text("Next ›", callback(page + 1));
  keyboard.row();
}

export async function buildModelCenterRoot(current?: ModelInfo): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const [favorites, recent] = await Promise.all([getFavoriteModels(), getRecentModels()]);
  const keyboard = new InlineKeyboard();
  keyboard.text(`⭐ Favorites · ${favorites.length}`, MODEL_CENTER_FAVORITES).text(`🕘 Recent models · ${recent.length}`, MODEL_CENTER_RECENT).row();
  keyboard.text("🔎 Search models", MODEL_CENTER_SEARCH).row();
  keyboard.text("🧩 Browse providers", MODEL_CENTER_PROVIDERS).row();
  keyboard.text("← Back", MODEL_CENTER_SETTINGS_BACK);

  const currentBlock = current?.providerID && current.modelID
    ? `🟢 <b>CURRENT MODEL</b>\n<code>${escapeHtml(formatModelName(current.modelID, current.name))}</code>`
    : "🟢 <b>CURRENT MODEL</b>\nNo model selected";

  return {
    text: ["🤖 <b>MODEL CENTER</b>", "", currentBlock, "", "Select a model, manage favorites, or browse the live provider catalog."].join("\n"),
    keyboard,
  };
}

export async function showModelCenterMenu(ctx: Context): Promise<void> {
  // Provider discovery can legitimately take seconds when a custom endpoint is
  // down. Never hold the Telegram reply open on network discovery. The refresh
  // service deduplicates concurrent runs and the next render will use the fresh
  // catalog once it is available.
  void refreshAllCustomProviderModels().catch((error) => {
    logger.warn("[ModelCenter] Background provider refresh failed", error);
  });

  const view = await buildModelCenterRoot(fetchCurrentModel());
  await replyWithInlineMenu(ctx, {
    menuKind: "model",
    text: view.text,
    keyboard: view.keyboard,
    parseMode: "HTML",
    metadata: { modelLists: { favorites: [], recent: [] } },
  });
}

export async function buildModelCenterList(kind: "favorites" | "recent", current?: ModelInfo): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const models = kind === "favorites" ? await getFavoriteModels() : await getRecentModels();
  const keyboard = new InlineKeyboard();
  await appendModelRows(keyboard, models, current);
  keyboard.text("← Model Center", MODEL_CENTER_ROOT);
  const title = kind === "favorites" ? "⭐ <b>FAVORITE MODELS</b>" : "🕘 <b>RECENT MODELS</b>";
  return {
    text: models.length ? `${title}\n\nModel names are shown without provider/company prefixes.` : `${title}\n\nNo models here yet.`,
    keyboard,
  };
}

export async function buildModelCenterProviders(): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const providers = await getProviders();
  const keyboard = new InlineKeyboard();
  providers.forEach((provider) => keyboard.text(`🧩 ${provider.name} · ${provider.modelCount} models`, `${MODEL_CENTER_PROVIDER_PREFIX}${encodeURIComponent(provider.id)}:0`).row());
  keyboard.text("← Model Center", MODEL_CENTER_ROOT);
  return {
    text: providers.length ? "🧩 <b>PROVIDERS</b>\n\nLive model catalog from every available provider." : "🧩 <b>PROVIDERS</b>\n\nNo providers are currently available.",
    keyboard,
  };
}

export async function buildModelCenterProvider(provider: ProviderInfo, page: number, current?: ModelInfo): Promise<{ text: string; keyboard: InlineKeyboard; page: number }> {
  const models = await getProviderModels(provider.id);
  const totalPages = Math.max(1, Math.ceil(models.length / MODELS_PER_PAGE));
  const normalizedPage = Math.min(Math.max(0, page), totalPages - 1);
  const pageModels = models.slice(normalizedPage * MODELS_PER_PAGE, (normalizedPage + 1) * MODELS_PER_PAGE);
  const keyboard = new InlineKeyboard();
  await appendModelRows(keyboard, pageModels, current);
  appendPagination(keyboard, normalizedPage, totalPages, (target) => `${MODEL_CENTER_PROVIDER_PREFIX}${encodeURIComponent(provider.id)}:${target}`);
  keyboard.text("← Providers", MODEL_CENTER_PROVIDERS).row();
  keyboard.text("← Model Center", MODEL_CENTER_ROOT);
  return {
    text: `🧩 <b>${escapeHtml(provider.name)}</b>\n\n${models.length} live models · page ${normalizedPage + 1}/${totalPages}.\nTap a model to select it or ☆/⭐ to manage favorites.`,
    keyboard,
    page: normalizedPage,
  };
}

export async function buildModelCenterSearchResults(query: string, current?: ModelInfo): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const models = (await searchModels(query)).slice(0, SEARCH_RESULTS_LIMIT);
  const keyboard = new InlineKeyboard();
  await appendModelRows(keyboard, models, current);
  keyboard.text("🔎 Search again", MODEL_CENTER_SEARCH_AGAIN).text("Cancel", MODEL_CENTER_SEARCH_CANCEL).row();
  return {
    text: models.length ? `🔎 <b>SEARCH</b> · <code>${escapeHtml(query)}</code>\n\nResults are shown by model name only.` : `🔎 <b>SEARCH</b>\n\nNo models matched <code>${escapeHtml(query)}</code>.`,
    keyboard,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
