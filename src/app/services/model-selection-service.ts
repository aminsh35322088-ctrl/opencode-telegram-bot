import { getCurrentModel, setCurrentModel } from "../stores/settings-store.js";
import { config } from "../../config.js";
import { opencodeClient } from "../../opencode/client.js";
import { listCustomProviders, listCustomProvidersByCapability, type AiCapability } from "./custom-provider-service.js";
import { isServerUnavailableError } from "../../utils/opencode-error.js";
import { logger } from "../../utils/logger.js";
import type { ModelInfo, FavoriteModel, ModelSelectionLists, ProviderInfo } from "../types/model.js";
import path from "node:path";

interface OpenCodeModelState {
  favorite?: Array<{ providerID?: string; modelID?: string }>;
  recent?: Array<{ providerID?: string; modelID?: string }>;
}

interface ProviderModelMetadata {
  name?: unknown;
}

const MODEL_CATALOG_CACHE_TTL_MS = 10 * 60 * 1000;
const COPILOT_PROVIDER_ID = "github-copilot";
let cachedValidModelKeys: Set<string> | null = null;
let cachedAllModels: FavoriteModel[] | null = null;
let cachedProviders: ProviderInfo[] | null = null;
let cachedModelsByProvider: Map<string, FavoriteModel[]> | null = null;
let modelCatalogCacheExpiresAt = 0;
let modelCatalogFetchInFlight: Promise<Set<string> | null> | null = null;
const SEARCH_RESULTS_LIMIT = 10;

function getModelKey(providerID: string, modelID: string) {
  return `${providerID}/${modelID}`;
}

function getEnvDefaultModel(): FavoriteModel | null {
  const providerID = config.opencode.model.provider;
  const modelID = config.opencode.model.modelId;
  return providerID && modelID ? { providerID, modelID } : null;
}

function getAdvertisedModelName(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const name = (metadata as ProviderModelMetadata).name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

function dedupeModels(models: FavoriteModel[]): FavoriteModel[] {
  const unique = new Map<string, FavoriteModel>();
  for (const model of models) {
    const key = getModelKey(model.providerID, model.modelID);
    const existing = unique.get(key);
    if (!existing) unique.set(key, model);
    else if ((!existing.name && model.name) || (!existing.freeStatus && model.freeStatus)) unique.set(key, { ...existing, ...model });
  }
  return [...unique.values()];
}

function filterModelsByCatalog(models: FavoriteModel[], valid: Set<string> | null) {
  return valid ? models.filter((m) => valid.has(getModelKey(m.providerID, m.modelID))) : models;
}

function enrichModelMetadata(models: FavoriteModel[]): FavoriteModel[] {
  if (!cachedAllModels) return models;
  const catalogByKey = new Map(cachedAllModels.map((model) => [getModelKey(model.providerID, model.modelID), model]));
  return models.map((model) => {
    const catalogModel = catalogByKey.get(getModelKey(model.providerID, model.modelID));
    return catalogModel ? { ...model, ...catalogModel } : model;
  });
}

function logFailure(error: unknown, type: "error" | "exception") {
  if (isServerUnavailableError(error)) {
    logger.warn("[ModelManager] OpenCode server is not running; skipping model catalog refresh");
    return;
  }
  logger.warn(`[ModelManager] ${type === "error" ? "Failed to refresh" : "Error refreshing"} model catalog:`, error);
}

async function getValidModelKeys(options?: { force?: boolean }): Promise<Set<string> | null> {
  const force = options?.force === true;
  if (!force && cachedValidModelKeys && Date.now() < modelCatalogCacheExpiresAt) return cachedValidModelKeys;
  if (modelCatalogFetchInFlight) {
    const inFlight = modelCatalogFetchInFlight;
    if (!force) return inFlight;
    await inFlight;
  }

  modelCatalogFetchInFlight = (async () => {
    try {
      const response = await opencodeClient.config.providers();
      if (response.error || !response.data) {
        logFailure(response.error, "error");
        return cachedValidModelKeys;
      }

      const customProviders = await listCustomProviders();
      const customProviderIds = new Set(customProviders.map((provider) => provider.id));
      const valid = new Set<string>();
      const all: FavoriteModel[] = [];
      const providers: ProviderInfo[] = [];
      const byProvider = new Map<string, FavoriteModel[]>();

      for (const provider of response.data.providers) {
        if (provider.id === COPILOT_PROVIDER_ID || customProviderIds.has(provider.id)) continue;

        const providerModels: FavoriteModel[] = Object.entries(provider.models).map(([modelID, metadata]) => ({
          providerID: provider.id,
          modelID,
          name: getAdvertisedModelName(metadata),
        }));

        for (const model of providerModels) {
          valid.add(getModelKey(model.providerID, model.modelID));
          all.push(model);
        }
        providerModels.sort((a, b) => a.modelID.localeCompare(b.modelID));
        byProvider.set(provider.id, providerModels);
        providers.push({ id: provider.id, name: provider.name || provider.id, modelCount: providerModels.length, freeModelCount: 0 });
      }

      for (const provider of customProviders) {
        const providerModels = dedupeModels(
          provider.models.map((model) => ({
            providerID: provider.id,
            modelID: model.id,
            name: model.name,
            freeStatus: model.freeStatus,
            freeConfidence: model.freeConfidence,
            pricing: model.pricing,
          })),
        );
        byProvider.set(provider.id, providerModels);
        for (const model of providerModels) {
          valid.add(getModelKey(model.providerID, model.modelID));
          all.push(model);
        }
        providers.push({
          id: provider.id,
          name: provider.name,
          modelCount: providerModels.length,
          freeModelCount: providerModels.filter((model) => model.freeStatus === "free" && model.freeConfidence === "high").length,
        });
      }

      const env = getEnvDefaultModel();
      if (env && !providers.some((provider) => provider.id === env.providerID)) {
        providers.push({ id: env.providerID, name: env.providerID === "opencode" ? "OpenCode" : env.providerID, modelCount: 1, freeModelCount: 0 });
        byProvider.set(env.providerID, [env]);
        logger.warn(`[ModelManager] Catalog omitted configured provider ${env.providerID}; preserving its configured default model for UI/recovery.`);
      } else if (env && !(byProvider.get(env.providerID) ?? []).some((model) => model.modelID === env.modelID)) {
        const merged = dedupeModels([...(byProvider.get(env.providerID) ?? []), env]);
        byProvider.set(env.providerID, merged);
        providers.find((provider) => provider.id === env.providerID)!.modelCount = merged.length;
      }

      providers.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      cachedValidModelKeys = valid;
      cachedAllModels = dedupeModels(all);
      cachedProviders = providers;
      cachedModelsByProvider = byProvider;
      modelCatalogCacheExpiresAt = Date.now() + MODEL_CATALOG_CACHE_TTL_MS;
      logger.info(
        `[ModelManager] Model catalog refreshed: providers=${providers.length}, models=${valid.size}, providerIds=${providers.map((p) => p.id).join(",")}, copilot=removed, customProviders=authoritative`,
      );
      return valid;
    } catch (err) {
      logFailure(err, "exception");
      return cachedValidModelKeys;
    } finally {
      modelCatalogFetchInFlight = null;
    }
  })();

  return modelCatalogFetchInFlight;
}

function normalizeFavoriteModels(state: OpenCodeModelState): FavoriteModel[] {
  return Array.isArray(state.favorite)
    ? state.favorite
        .filter(
          (m): m is { providerID: string; modelID: string } =>
            typeof m?.providerID === "string" && !!m.providerID && typeof m.modelID === "string" && !!m.modelID,
        )
        .map((m) => ({ providerID: m.providerID, modelID: m.modelID }))
    : [];
}

function normalizeRecentModels(state: OpenCodeModelState): FavoriteModel[] {
  return Array.isArray(state.recent)
    ? state.recent
        .filter(
          (m): m is { providerID: string; modelID: string } =>
            typeof m?.providerID === "string" && !!m.providerID && typeof m.modelID === "string" && !!m.modelID,
        )
        .map((m) => ({ providerID: m.providerID, modelID: m.modelID }))
    : [];
}

function getOpenCodeModelStatePath() {
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg?.trim()) return path.join(xdg, "opencode", "model.json");
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return path.join(home, ".local", "state", "opencode", "model.json");
}

export async function getModelSelectionLists(): Promise<ModelSelectionLists> {
  const env = getEnvDefaultModel();
  try {
    const fs = await import("fs/promises");
    const state = JSON.parse(await fs.readFile(getOpenCodeModelStatePath(), "utf-8")) as OpenCodeModelState;
    const valid = await getValidModelKeys();
    const favorites = enrichModelMetadata(
      env
        ? dedupeModels([...filterModelsByCatalog(normalizeFavoriteModels(state), valid), env])
        : filterModelsByCatalog(normalizeFavoriteModels(state), valid),
    );
    const recent = enrichModelMetadata(filterModelsByCatalog(normalizeRecentModels(state), valid));
    const keys = new Set(favorites.map((m) => getModelKey(m.providerID, m.modelID)));
    return { favorites, recent: dedupeModels(recent).filter((m) => !keys.has(getModelKey(m.providerID, m.modelID))) };
  } catch (err) {
    if (env) return { favorites: [env], recent: [] };
    logger.warn("[ModelManager] OpenCode model state unavailable; returning empty favorites/recent:", err);
    return { favorites: [], recent: [] };
  }
}

export async function reconcileStoredModelSelection(options?: { forceCatalogRefresh?: boolean }) {
  const valid = options?.forceCatalogRefresh ? await getValidModelKeys({ force: true }) : await getValidModelKeys();
  const current = getCurrentModel();
  if (!current?.providerID || !current.modelID || !valid || valid.has(getModelKey(current.providerID, current.modelID))) return;
  const fallback = getEnvDefaultModel();
  if (fallback && valid.has(getModelKey(fallback.providerID, fallback.modelID))) {
    logger.warn(`[ModelManager] Stored model unavailable; falling back to ${getModelKey(fallback.providerID, fallback.modelID)}`);
    setCurrentModel({ ...fallback, variant: "default" });
  }
}

export async function refreshModelCatalog(): Promise<void> {
  await getValidModelKeys({ force: true });
}

export function __resetModelCatalogCacheForTests() {
  cachedValidModelKeys = null;
  cachedAllModels = null;
  cachedProviders = null;
  cachedModelsByProvider = null;
  modelCatalogCacheExpiresAt = 0;
  modelCatalogFetchInFlight = null;
}

export async function getFavoriteModels() {
  return (await getModelSelectionLists()).favorites;
}

export async function getProviders() {
  await getValidModelKeys();
  return cachedProviders ?? [];
}

export async function getProvidersForCapability(capability: AiCapability) {
  const customProviders = await listCustomProvidersByCapability(capability);
  if (capability !== "coding") return customProviders.map((p) => ({ id: p.id, name: p.name, modelCount: p.models.length, freeModelCount: p.models.filter((model) => model.freeStatus === "free" && model.freeConfidence === "high").length }));
  await getValidModelKeys();
  const merged = new Map((cachedProviders ?? []).map((provider) => [provider.id, { id: provider.id, name: provider.name, modelCount: provider.modelCount, freeModelCount: provider.freeModelCount ?? 0 }]));
  for (const provider of customProviders) {
    const existing = merged.get(provider.id);
    const freeModelCount = provider.models.filter((model) => model.freeStatus === "free" && model.freeConfidence === "high").length;
    if (existing) {
      existing.modelCount = Math.max(existing.modelCount, provider.models.length);
      existing.freeModelCount = Math.max(existing.freeModelCount ?? 0, freeModelCount);
    } else merged.set(provider.id, { id: provider.id, name: provider.name, modelCount: provider.models.length, freeModelCount });
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export async function getProviderModels(providerID: string) {
  await getValidModelKeys();
  return cachedModelsByProvider?.get(providerID) ?? [];
}

export async function getProviderModelsForCapability(providerID: string, capability: AiCapability) {
  if (capability === "coding") {
    await getValidModelKeys();
    const openCodeModels = cachedModelsByProvider?.get(providerID) ?? [];
    const customProvider = (await listCustomProvidersByCapability(capability)).find((p) => p.id === providerID);
    const customModels = customProvider?.models.map((m) => ({ providerID, modelID: m.id, name: m.name, freeStatus: m.freeStatus, freeConfidence: m.freeConfidence, pricing: m.pricing })) ?? [];
    return dedupeModels([...openCodeModels, ...customModels]);
  }
  const provider = (await listCustomProvidersByCapability(capability)).find((p) => p.id === providerID);
  return provider?.models.map((m) => ({ providerID, modelID: m.id, name: m.name, freeStatus: m.freeStatus, freeConfidence: m.freeConfidence, pricing: m.pricing })) ?? [];
}

export async function resolveCatalogModel(providerID: string, modelID: string, options?: { forceRefresh?: boolean }): Promise<ModelInfo | null> {
  const valid = await getValidModelKeys({ force: options?.forceRefresh === true });
  if (!valid || !cachedAllModels) return null;
  const exact = cachedAllModels.find((model) => model.providerID === providerID && model.modelID === modelID);
  if (exact) return { ...exact, variant: "default" };
  const exactMatches = cachedAllModels.filter((model) => model.modelID === modelID);
  const match = exactMatches.length === 1 ? exactMatches[0] : undefined;
  return match ? { ...match, variant: "default" } : null;
}

export async function searchModels(query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const valid = await getValidModelKeys();
  if (!valid || !cachedAllModels) return [];
  return cachedAllModels
    .filter((m) => `${m.modelID} ${m.name ?? ""}`.toLowerCase().includes(q))
    .slice(0, SEARCH_RESULTS_LIMIT);
}

export function fetchCurrentModel(): ModelInfo {
  return getStoredModel();
}

export function selectModel(modelInfo: ModelInfo) {
  logger.info(`[ModelManager] Selected model: ${modelInfo.providerID}/${modelInfo.modelID}`);
  setCurrentModel(modelInfo);
}

export function getStoredModel(): ModelInfo {
  const stored = getCurrentModel();
  if (stored) {
    if (!stored.variant) stored.variant = "default";
    return stored;
  }
  if (config.opencode.model.provider && config.opencode.model.modelId)
    return { providerID: config.opencode.model.provider, modelID: config.opencode.model.modelId, variant: "default" };
  return { providerID: "", modelID: "", variant: "default" };
}
