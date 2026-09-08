import { createHash } from "node:crypto";
import { InlineKeyboard } from "grammy";
import { getFavoriteModels, getRecentModels } from "../../app/services/model-preferences-service.js";
import { fetchCurrentModel, getProviderModels, getProviders, searchModels } from "../../app/services/model-selection-service.js";
import { refreshAllCustomProviderModels } from "../../app/services/model-catalog-refresh-service.js";
import { formatModelName, type FavoriteModel, type ModelInfo, type ProviderInfo } from "../../app/types/model.js";
import { logger } from "../../utils/logger.js";
import type { Context } from "grammy";
import { replyWithInlineMenu } from "./inline-menu.js";

const MODEL_CENTER_ROOT = "mc:root";
const MODEL_CENTER_FAVORITES = "mc:favorites";
const MODEL_CENTER_RECENT = "mc:recent";
const MODEL_CENTER_PROVIDERS = "mc:providers";
const MODEL_CENTER_SEARCH = "mc:search";
const MODEL_CENTER_SEARCH_AGAIN = "mc:search-again";
const MODEL_CENTER_SEARCH_CANCEL = "mc:search-cancel";
const MODEL_CENTER_SETTINGS_BACK = "settings:back";
const MODEL_CENTER_PROVIDER_PREFIX = "mc:provider:";
const MODEL_CENTER_SELECT_PREFIX = "mc:select:";
const MODEL_CENTER_FAVORITE_PREFIX = "mc:favorite:";
const SEARCH_RESULTS_LIMIT = 10;
const MODELS_PER_PAGE = 8;

type ModelCenterFavoriteTarget =
  | { kind: "root" }
  | { kind: "list"; list: "favorites" | "recent" }
  | { kind: "provider"; providerID: string; page: number }
  | { kind: "search"; query: string };

function modelKey(model: { providerID: string; modelID: string }): string { return `${model.providerID}/${model.modelID}`; }
function escapeHtml(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;"); }
function actionToken(model: ModelInfo, target: ModelCenterFavoriteTarget): string { return createHash("sha1").update(JSON.stringify({ model, target })).digest("hex").slice(0, 10); }
function modelButtonLabel(model: FavoriteModel, active: boolean, favorite: boolean): string { return `${active ? "✅ " : ""}${formatModelName(model.modelID, model.name)}${favorite ? " ⭐" : ""}`; }

async function appendModelRows(keyboard: InlineKeyboard, models: FavoriteModel[], current: ModelInfo | undefined, target: Omit<ModelCenterFavoriteTarget, "kind"> & { kind: ModelCenterFavoriteTarget["kind"] }): Promise<void> {
  const favoriteKeys = new Set((await getFavoriteModels()).map(modelKey));
  for (const model of models) {
    const info: ModelInfo = { providerID: model.providerID, modelID: model.modelID, name: model.name, variant: "default" };
    const token = actionToken(info, target);
    const favorite = favoriteKeys.has(modelKey(model));
    const active = !!current && modelKey(current) === modelKey(model);
    keyboard.text(modelButtonLabel(model, active, favorite), `${MODEL_CENTER_SELECT_PREFIX}${token}`);
    keyboard.text(favorite ? "⭐" : "☆", `${MODEL_CENTER_FAVORITE_PREFIX}${token}`).row();
  }
}

export function resolveModelCenterAction(token: string): ModelInfo | undefined {
  const target = modelActionRegistry.get(token);
  return target?.model;
}

export function resolveModelCenterFavoriteTarget(token: string): ModelCenterFavoriteTarget | undefined {
  return modelActionRegistry.get(token)?.target;
}

const modelActionRegistry = new Map<string, { model: ModelInfo; target: ModelCenterFavoriteTarget }>();

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
    ? `🟢 <b>Current model</b>\n<code>${escapeHtml(formatModelName(current.modelID, current.name))}</code>`
    : "🟢 <b>Current model</b>\nNo model selected";

  return {
    text: [
      "🤖 <b>Model Center</b>",
      "",
      currentBlock,
      "",
      "Select a model for this Topic, browse providers, search the live catalog, or manage favorites.",
    ].join("\n"),
    keyboard,
  };
}

export async function showModelCenterMenu(ctx: Context): Promise<void> {
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
  await appendModelRows(keyboard, models, current, { kind: "list", list: kind });
  keyboard.text("← Model Center", MODEL_CENTER_ROOT);
  const title = kind === "favorites" ? "⭐ <b>Favorite Models</b>" : "🕘 <b>Recent Models</b>";
  return {
    text: [
      title,
      "",
      models.length ? "Choose a model below. The active Topic model is marked with ✅." : "No models are available in this list yet.",
    ].join("\n"),
    keyboard,
  };
}

export async function buildModelCenterProviders(): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const providers = await getProviders();
  const keyboard = new InlineKeyboard();
  providers.forEach((provider) => keyboard.text(`🧩 ${provider.name} · ${provider.modelCount} models`, `${MODEL_CENTER_PROVIDER_PREFIX}${encodeURIComponent(provider.id)}:0`).row());
  keyboard.text("← Model Center", MODEL_CENTER_ROOT);
  return {
    text: [
      "🧩 <b>Providers</b>",
      "",
      providers.length ? "Live coding providers discovered by OpenCode. Open one to browse its available models." : "No providers are currently available.",
    ].join("\n"),
    keyboard,
  };
}

export async function buildModelCenterProvider(provider: ProviderInfo, page: number, current?: ModelInfo): Promise<{ text: string; keyboard: InlineKeyboard; page: number }> {
  const models = await getProviderModels(provider.id);
  const totalPages = Math.max(1, Math.ceil(models.length / MODELS_PER_PAGE));
  const normalizedPage = Math.min(Math.max(0, page), totalPages - 1);
  const pageModels = models.slice(normalizedPage * MODELS_PER_PAGE, (normalizedPage + 1) * MODELS_PER_PAGE);
  const keyboard = new InlineKeyboard();
  await appendModelRows(keyboard, pageModels, current, { kind: "provider", providerID: provider.id, page: normalizedPage });
  appendPagination(keyboard, normalizedPage, totalPages, (target) => `${MODEL_CENTER_PROVIDER_PREFIX}${encodeURIComponent(provider.id)}:${target}`);
  keyboard.text("← Providers", MODEL_CENTER_PROVIDERS).row();
  keyboard.text("← Model Center", MODEL_CENTER_ROOT);
  return {
    text: [
      `🧩 <b>${escapeHtml(provider.name)}</b>`,
      "",
      `${models.length} live models · page ${normalizedPage + 1}/${totalPages}.`,
      "Tap a model to select it or ☆/⭐ to manage favorites.",
    ].join("\n"),
    keyboard,
    page: normalizedPage,
  };
}

export async function buildModelCenterSearchResults(query: string, current?: ModelInfo): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const models = (await searchModels(query)).slice(0, SEARCH_RESULTS_LIMIT);
  const keyboard = new InlineKeyboard();
  await appendModelRows(keyboard, models, current, { kind: "search", query });
  keyboard.text("🔎 Search again", MODEL_CENTER_SEARCH_AGAIN).text("← Back", MODEL_CENTER_ROOT).row();
  return {
    text: [
      "🔎 <b>Search Models</b>",
      "",
      models.length ? `Results for <code>${escapeHtml(query)}</code>.` : `No models matched <code>${escapeHtml(query)}</code>.`,
    ].join("\n"),
    keyboard,
  };
}
