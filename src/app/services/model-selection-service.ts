import { getCurrentModel, setCurrentModel } from "../stores/settings-store.js";
import { config } from "../../config.js";
import { opencodeClient } from "../../opencode/client.js";
import { isServerUnavailableError } from "../../utils/opencode-error.js";
import { logger } from "../../utils/logger.js";
import type { ModelInfo, FavoriteModel, ModelSelectionLists, ProviderInfo } from "../types/model.js";
import path from "node:path";

interface OpenCodeModelState { favorite?: Array<{ providerID?: string; modelID?: string }>; recent?: Array<{ providerID?: string; modelID?: string }>; }
const MODEL_CATALOG_CACHE_TTL_MS = 10 * 60 * 1000;
let cachedValidModelKeys: Set<string> | null = null;
let cachedAllModels: FavoriteModel[] | null = null;
let cachedProviders: ProviderInfo[] | null = null;
let cachedModelsByProvider: Map<string, FavoriteModel[]> | null = null;
let modelCatalogCacheExpiresAt = 0;
let modelCatalogFetchInFlight: Promise<Set<string> | null> | null = null;
const SEARCH_RESULTS_LIMIT = 10;
function getModelKey(providerID: string, modelID: string): string { return `${providerID}/${modelID}`; }
function getEnvDefaultModel(): FavoriteModel | null { const providerID = config.opencode.model.provider; const modelID = config.opencode.model.modelId; return providerID && modelID ? { providerID, modelID } : null; }
function dedupeModels(models: FavoriteModel[]): FavoriteModel[] { const unique = new Map<string, FavoriteModel>(); for (const model of models) { const key = getModelKey(model.providerID, model.modelID); if (!unique.has(key)) unique.set(key, model); } return Array.from(unique.values()); }
function filterModelsByCatalog(models: FavoriteModel[], validModelKeys: Set<string> | null): FavoriteModel[] { return validModelKeys ? models.filter(model => validModelKeys.has(getModelKey(model.providerID, model.modelID))) : models; }
function logModelCatalogRefreshFailure(error: unknown, type: "error" | "exception"): void { if (isServerUnavailableError(error)) { logger.warn("[ModelManager] OpenCode server is not running; skipping model catalog refresh"); return; } type === "error" ? logger.warn("[ModelManager] Failed to refresh model catalog:", error) : logger.warn("[ModelManager] Error refreshing model catalog:", error); }
async function getValidModelKeys(options?: { force?: boolean }): Promise<Set<string> | null> {
  if (!options?.force && cachedValidModelKeys && Date.now() < modelCatalogCacheExpiresAt) return cachedValidModelKeys;
  if (modelCatalogFetchInFlight) return modelCatalogFetchInFlight;
  modelCatalogFetchInFlight = (async () => {
    try {
      const response = await opencodeClient.config.providers();
      if (response.error || !response.data) { logModelCatalogRefreshFailure(response.error, "error"); return cachedValidModelKeys; }
      const validModelKeys = new Set<string>(); const allModels: FavoriteModel[] = []; const providers: ProviderInfo[] = []; const modelsByProvider = new Map<string, FavoriteModel[]>();
      for (const provider of response.data.providers) {
        const providerModels: FavoriteModel[] = Object.keys(provider.models).map(modelID => ({ providerID: provider.id, modelID }));
        for (const model of providerModels) { validModelKeys.add(getModelKey(model.providerID, model.modelID)); allModels.push(model); }
        if (providerModels.length === 0) continue;
        providerModels.sort((a, b) => a.modelID.localeCompare(b.modelID)); modelsByProvider.set(provider.id, providerModels);
        providers.push({ id: provider.id, name: provider.name || provider.id, modelCount: providerModels.length });
      }
      providers.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      cachedValidModelKeys = validModelKeys; cachedAllModels = allModels; cachedProviders = providers; cachedModelsByProvider = modelsByProvider; modelCatalogCacheExpiresAt = Date.now() + MODEL_CATALOG_CACHE_TTL_MS;
      logger.info(`[ModelManager] Model catalog refreshed: providers=${providers.length}, models=${validModelKeys.size}`);
      return cachedValidModelKeys;
    } catch (err) { logModelCatalogRefreshFailure(err, "exception"); return cachedValidModelKeys; }
    finally { modelCatalogFetchInFlight = null; }
  })();
  return modelCatalogFetchInFlight;
}
function normalizeFavoriteModels(state: OpenCodeModelState): FavoriteModel[] { return Array.isArray(state.favorite) ? state.favorite.filter((m): m is { providerID: string; modelID: string } => typeof m?.providerID === "string" && !!m.providerID && typeof m.modelID === "string" && !!m.modelID).map(m => ({ providerID: m.providerID, modelID: m.modelID })) : []; }
function normalizeRecentModels(state: OpenCodeModelState): FavoriteModel[] { return Array.isArray(state.recent) ? state.recent.filter((m): m is { providerID: string; modelID: string } => typeof m?.providerID === "string" && !!m.providerID && typeof m.modelID === "string" && !!m.modelID).map(m => ({ providerID: m.providerID, modelID: m.modelID })) : []; }
function getOpenCodeModelStatePath(): string { const xdg = process.env.XDG_STATE_HOME; if (xdg?.trim()) return path.join(xdg, "opencode", "model.json"); const home = process.env.HOME || process.env.USERPROFILE || ""; return path.join(home, ".local", "state", "opencode", "model.json"); }
export async function getModelSelectionLists(): Promise<ModelSelectionLists> { const envDefaultModel = getEnvDefaultModel(); try { const fs = await import("fs/promises"); const stateFilePath = getOpenCodeModelStatePath(); const state = JSON.parse(await fs.readFile(stateFilePath, "utf-8")) as OpenCodeModelState; const rawFavorites = normalizeFavoriteModels(state); const rawRecent = normalizeRecentModels(state); const validModelKeys = rawFavorites.length || rawRecent.length ? await getValidModelKeys() : null; const validatedFavorites = filterModelsByCatalog(rawFavorites, validModelKeys); const validatedRecent = filterModelsByCatalog(rawRecent, validModelKeys); const favorites = envDefaultModel ? dedupeModels([...validatedFavorites, envDefaultModel]) : validatedFavorites; const favoriteKeys = new Set(favorites.map(m => getModelKey(m.providerID, m.modelID))); return { favorites, recent: dedupeModels(validatedRecent).filter(m => !favoriteKeys.has(getModelKey(m.providerID, m.modelID))) }; } catch (err) { if (envDefaultModel) { logger.warn("[ModelManager] Failed to load OpenCode model state, using config model as favorite:", err); return { favorites: [envDefaultModel], recent: [] }; } logger.warn("[ModelManager] OpenCode model state unavailable; returning empty favorites/recent:", err); return { favorites: [], recent: [] }; } }
export async function reconcileStoredModelSelection(options?: { forceCatalogRefresh?: boolean }): Promise<void> { const valid = options?.forceCatalogRefresh === undefined ? await getValidModelKeys() : await getValidModelKeys({ force: options.forceCatalogRefresh }); const currentModel = getCurrentModel(); if (!currentModel?.providerID || !currentModel.modelID || !valid || valid.has(getModelKey(currentModel.providerID, currentModel.modelID))) return; const fallback = getEnvDefaultModel(); if (!fallback || !valid.has(getModelKey(fallback.providerID, fallback.modelID))) return; logger.warn(`[ModelManager] Stored model ${getModelKey(currentModel.providerID,currentModel.modelID)} is unavailable, falling back to ${getModelKey(fallback.providerID,fallback.modelID)}`); setCurrentModel({ providerID: fallback.providerID, modelID: fallback.modelID, variant: "default" }); }
export function __resetModelCatalogCacheForTests(): void { cachedValidModelKeys = null; cachedAllModels = null; cachedProviders = null; cachedModelsByProvider = null; modelCatalogCacheExpiresAt = 0; modelCatalogFetchInFlight = null; }
export async function getFavoriteModels(): Promise<FavoriteModel[]> { return (await getModelSelectionLists()).favorites; }
export async function getProviders(): Promise<ProviderInfo[]> { await getValidModelKeys(); return cachedProviders ?? []; }
export async function getProviderModels(providerID: string): Promise<FavoriteModel[]> { await getValidModelKeys(); return cachedModelsByProvider?.get(providerID) ?? []; }
export async function searchModels(query: string): Promise<FavoriteModel[]> { const q = query.trim().toLowerCase(); if (!q) return []; const valid = await getValidModelKeys(); if (!valid || !cachedAllModels) return []; return cachedAllModels.filter(m => getModelKey(m.providerID, m.modelID).toLowerCase().includes(q)).sort((a,b) => getModelKey(a.providerID,a.modelID).localeCompare(getModelKey(b.providerID,b.modelID))).slice(0, SEARCH_RESULTS_LIMIT); }
export function fetchCurrentModel(): ModelInfo { return getStoredModel(); }
export function selectModel(modelInfo: ModelInfo): void { logger.info(`[ModelManager] Selected model: ${modelInfo.providerID}/${modelInfo.modelID}`); setCurrentModel(modelInfo); }
export function getStoredModel(): ModelInfo { const stored = getCurrentModel(); if (stored) { if (!stored.variant) stored.variant = "default"; return stored; } if (config.opencode.model.provider && config.opencode.model.modelId) return { providerID: config.opencode.model.provider, modelID: config.opencode.model.modelId, variant: "default" }; return { providerID: "", modelID: "", variant: "default" }; }
