import { getProviderPriceView } from "./provider-price-view.js";
import { PRICE_COLOR, type ModelPrice } from "../../app/services/model-price-classifier.js";
import { createHash } from "node:crypto";
import { InlineKeyboard } from "grammy";
import { getFavoriteModels, getRecentModels } from "../../app/services/model-preferences-service.js";
import { fetchCurrentModel, getProviderModels, getProviders, searchModels } from "../../app/services/model-selection-service.js";
import { refreshAllCustomProviderModels } from "../../app/services/model-catalog-refresh-service.js";
import { formatModelName, type FavoriteModel, type ModelInfo, type ProviderInfo } from "../../app/types/model.js";
import { logger } from "../../utils/logger.js";
import type { Context } from "grammy";
import { replyWithInlineMenu } from "./inline-menu.js";

export const MODEL_CENTER_PRICE_LEGEND = "mc:price_legend";
export const MODEL_CENTER_PRICE_PAGE_PREFIX = "mc:priced:";
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

export type ModelCenterFavoriteTarget =
  | { kind: "root" }
  | { kind: "list"; list: "favorites" | "recent" }
  | { kind: "provider"; providerID: string; page: number; viewID?: string }
  | { kind: "search"; query: string };

const favoriteTargets = new Map<string, ModelCenterFavoriteTarget>();

function modelKey(model: FavoriteModel | ModelInfo): string {
  return `${model.providerID}/${model.modelID}`;
}

function actionToken(model: ModelInfo, favoriteTarget?: ModelCenterFavoriteTarget): string {
  const token = createHash("sha256")
    .update(`${modelKey(model)}:${model.variant ?? "default"}:${JSON.stringify(favoriteTarget)}`)
    .digest("base64url")
    .slice(0, 10);
  actionModels.delete(token);
  favoriteTargets.delete(token);
  actionModels.set(token, {
    providerID: model.providerID,
    modelID: model.modelID,
    name: model.name,
    variant: model.variant ?? "default",
  });
  if (favoriteTarget) favoriteTargets.set(token, favoriteTarget);
  while (actionModels.size > MAX_ACTION_MODELS) {
    const oldest = actionModels.keys().next().value as string | undefined;
    if (!oldest) break;
    actionModels.delete(oldest);
    favoriteTargets.delete(oldest);
  }
  return token;
}

export function resolveModelCenterAction(token: string): ModelInfo | null {
  return actionModels.get(token) ?? null;
}

export function resolveModelCenterFavoriteTarget(token: string): ModelCenterFavoriteTarget | null {
  return favoriteTargets.get(token) ?? null;
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
  favoriteTarget?: ModelCenterFavoriteTarget,
  prices?: Map<string, ModelPrice>,
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
    const token = actionToken(info, favoriteTarget);
    const favorite = favoriteKeys.has(modelKey(model));
    const active = !!current && modelKey(current) === modelKey(model);

    const label = prices
      ? PRICE_COLOR[prices.get(model.modelID)?.group ?? "unknown"] + " " + formatModelName(model.modelID, model.name) + (active ? " ✓" : "") + (favorite ? " ⭐" : "")
      : modelButtonLabel(model, active, favorite);
    keyboard.text(label, `${MODEL_CENTER_SELECT_PREFIX}${token}`);
    keyboard.text(favorite ? "⭐" : "☆", `${MODEL_CENTER_FAVORITE_PREFIX}${token}`).row();
  }
}

function isTopicContext(ctx: Context): boolean {
  const message = ctx.message ?? ctx.callbackQuery?.message;
  const threadId = message && "message_thread_id" in message ? (message as { message_thread_id?: number }).message_thread_id : undefined;
  return typeof threadId === "number" && threadId > 1;
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
    text: [
      "🤖 <b>MODEL CENTER</b>",
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
    navigation: isTopicContext(ctx) ? "both" : "auto",
  });
}

export async function buildModelCenterList(kind: "favorites" | "recent", current?: ModelInfo): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const models = kind === "favorites" ? await getFavoriteModels() : await getRecentModels();
  const keyboard = new InlineKeyboard();
  await appendModelRows(keyboard, models, current, { kind: "list", list: kind });
  keyboard.text("← Model Center", MODEL_CENTER_ROOT);
  const title = kind === "favorites" ? "⭐ <b>FAVORITE MODELS</b>" : "🕘 <b>RECENT MODELS</b>";
  return {
    text: models.length
      ? `${title}\n\nChoose a model below. The active Topic model is marked with 🟢.`
      : `${title}\n\nNo models here yet.`,
    keyboard,
  };
}

export async function buildModelCenterProviders(): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const providers = await getProviders();
  const keyboard = new InlineKeyboard();
  providers.forEach((provider) => keyboard.text(`🧩 ${provider.name} · ${provider.modelCount} models`, `${MODEL_CENTER_PROVIDER_PREFIX}${encodeURIComponent(provider.id)}:0`).row());
  keyboard.text("← Model Center", MODEL_CENTER_ROOT);
  return {
    text: providers.length
      ? "🧩 <b>PROVIDERS</b>\n\nLive coding providers discovered by OpenCode. Open one to browse its models."
      : "🧩 <b>PROVIDERS</b>\n\nNo providers are currently available.",
    keyboard,
  };
}

export async function buildModelCenterProvider(provider: ProviderInfo, page: number, current?: ModelInfo, viewID?: string): Promise<{ text: string; keyboard: InlineKeyboard; page: number }> {
  const catalogModels = await getProviderModels(provider.id);
  const view = await getProviderPriceView(provider.id, catalogModels, viewID);
  const models = view?.models ?? catalogModels;
  const totalPages = Math.max(1, Math.ceil(models.length / MODELS_PER_PAGE));
  const normalizedPage = Math.min(Math.max(0, page), totalPages - 1);
  const pageModels = models.slice(normalizedPage * MODELS_PER_PAGE, (normalizedPage + 1) * MODELS_PER_PAGE);
  const keyboard = new InlineKeyboard();
  await appendModelRows(keyboard, pageModels, current, { kind: "provider", providerID: provider.id, page: normalizedPage, viewID: view?.id }, view?.prices);
  appendPagination(keyboard, normalizedPage, totalPages, (target) => view ? MODEL_CENTER_PRICE_PAGE_PREFIX + view.id + ":" + target : `${MODEL_CENTER_PROVIDER_PREFIX}${encodeURIComponent(provider.id)}:${target}`);
  if (view) keyboard.text("ⓘ Colors", MODEL_CENTER_PRICE_LEGEND).row();
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
  await appendModelRows(keyboard, models, current, { kind: "search", query });
  keyboard.text("🔎 Search again", MODEL_CENTER_SEARCH_AGAIN).text("← Back", MODEL_CENTER_ROOT).row();
  return {
    text: models.length
      ? `🔎 <b>SEARCH</b> · <code>${escapeHtml(query)}</code>\n\nResults are shown by model name only.`
      : `🔎 <b>SEARCH</b>\n\nNo models matched <code>${escapeHtml(query)}</code>.`,
    keyboard,
  };
}

function appendPagination(keyboard: InlineKeyboard, page: number, totalPages: number, callback: (page: number) => string): void {
  if (totalPages <= 1) return;
  if (page > 0) keyboard.text("‹ Prev", callback(page - 1));
  if (page < totalPages - 1) keyboard.text("Next ›", callback(page + 1));
  keyboard.row();
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
}
