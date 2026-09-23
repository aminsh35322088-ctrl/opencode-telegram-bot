import { getCurrentModel, setCurrentModel } from "../stores/settings-store.js";
import { config } from "../../config.js";
import { opencodeClient } from "../../opencode/client.js";
import { ensureCustomProviderModelToolCapability, listCustomProviders, listCustomProvidersByCapability, type AiCapability } from "./custom-provider-service.js";
import { isServerUnavailableError } from "../../utils/opencode-error.js";
import { logger } from "../../utils/logger.js";
import type { ModelInfo, FavoriteModel, ModelSelectionLists, ProviderInfo } from "../types/model.js";
import path from "node:path";
import { isAgentToolCapableModelMetadata, isChatModelMetadata } from "./model-eligibility-service.js";

const cachedPriceMetadata = new Map<string, { fetchedAt: number; models: Array<[string, unknown]> }>();
export function getCachedProviderPriceMetadata(providerID: string) { return cachedPriceMetadata.get(providerID); }

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

export interface ModelFallbackEvent {
  previous: string;
  next: string;
  reason: "unavailable_or_not_tool_capable";
}

type ModelFallbackListener = (event: ModelFallbackEvent) => void;

let modelFallbackListener: ModelFallbackListener | null = null;

export function setModelFallbackListener(listener: ModelFallbackListener | null): void {
  modelFallbackListener = listener;
}

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
    else if (!existing.name && model.name) unique.set(key, { ...existing, name: model.name });
  }
  return [...unique.values()];
}

function filterModelsByCatalog(models: FavoriteModel[], valid: Set<string> | null) {
  return valid ? models.filter((m) => valid.has(getModelKey(m.providerID, m.modelID))) : models;
}

function enrichModelNames(models: FavoriteModel[]): FavoriteModel[] {
  if (!cachedAllModels) return models;
  const catalogByKey = new Map(cachedAllModels.map((model) => [getModelKey(model.providerID, model.modelID), model]));
  return models.map((model) => {
    const catalogModel = catalogByKey.get(getModelKey(model.providerID, model.modelID));
    return catalogModel?.name ? { ...model, name: catalogModel.name } : model;
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

      const customProviders = (await listCustomProviders()).filter((provider) => provider.capability !== "stt");
      const customProviderIds = new Set((await listCustomProviders()).map((provider) => provider.id));
      const valid = new Set<string>();
      const all: FavoriteModel[] = [];
      const providers: ProviderInfo[] = [];
      const byProvider = new Map<string, FavoriteModel[]>();
      const priceMetadata = new Map<string, { fetchedAt: number; models: Array<[string, unknown]> }>();

      for (const provider of response.data.providers) {
        if (provider.id === COPILOT_PROVIDER_ID || customProviderIds.has(provider.id)) continue;

        priceMetadata.set(provider.id, { fetchedAt: Date.now(), models: Object.entries(provider.models) });
        const providerModels: FavoriteModel[] = Object.entries(provider.models).filter(([, metadata]) => isAgentToolCapableModelMetadata(metadata)).map(([modelID, metadata]) => ({
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
        providers.push({ id: provider.id, name: provider.name || provider.id, modelCount: providerModels.length });
      }

      for (const provider of customProviders) {
        // Keep the full chat-capable catalog visible. Custom models become
        // selectable only after ensureCustomProviderModelToolCapability()
        // completes a live tool-call verification for the exact model.
        const providerModels = dedupeModels(
          provider.models.filter(isChatModelMetadata).map((model) => ({
            providerID: provider.id,
            modelID: model.id,
            name: model.name,
          })),
        );
        const verifiedKeys = new Set(
          provider.models
            .filter((model) => model.toolCall === true && model.toolCallVerified === true && isChatModelMetadata(model))
            .map((model) => getModelKey(provider.id, model.id)),
        );
        byProvider.set(provider.id, providerModels);
        for (const model of providerModels) {
          if (verifiedKeys.has(getModelKey(model.providerID, model.modelID))) {
            valid.add(getModelKey(model.providerID, model.modelID));
          }
          all.push(model);
        }
        providers.push({ id: provider.id, name: provider.name, modelCount: providerModels.length });
      }

      const env = getEnvDefaultModel();
      const envProvider = response.data.providers.find((p) => p.id === env?.providerID);
      const envCustom = (await listCustomProviders()).find((p) => p.id === env?.providerID);
      const envProviderModel = env && envProvider?.models[env.modelID];
      const envCustomModel = env && envCustom?.models.find((m) => m.id === env.modelID);
      const envAllowed = Boolean(
        env && (
          envCustom
            ? envCustom.capability !== "stt" && envCustomModel?.toolCall === true && envCustomModel.toolCallVerified === true && isChatModelMetadata(envCustomModel)
            : envProviderModel
              ? isAgentToolCapableModelMetadata(envProviderModel)
              : env.providerID === "opencode"
        )
      );
      if (env && envAllowed) {
        valid.add(getModelKey(env.providerID, env.modelID));
        all.push(env);

        if (!providers.some((provider) => provider.id === env.providerID)) {
          providers.push({
            id: env.providerID,
            name: env.providerID === "opencode" ? "OpenCode" : env.providerID,
            modelCount: 1,
          });
          byProvider.set(env.providerID, [env]);
          logger.warn(
            `[ModelManager] Catalog omitted configured provider ${env.providerID}; preserving its configured default model for UI/recovery.`,
          );
        } else if (!(byProvider.get(env.providerID) ?? []).some((model) => model.modelID === env.modelID)) {
          const merged = dedupeModels([...(byProvider.get(env.providerID) ?? []), env]);
          byProvider.set(env.providerID, merged);
          providers.find((provider) => provider.id === env.providerID)!.modelCount = merged.length;
        }
      }

      providers.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      cachedValidModelKeys = valid;
      cachedAllModels = dedupeModels(all);
      cachedProviders = providers.filter(p => p.modelCount > 0);
      cachedModelsByProvider = byProvider;
      cachedPriceMetadata.clear();
      for (const [id, metadata] of priceMetadata) cachedPriceMetadata.set(id, metadata);
      modelCatalogCacheExpiresAt = Date.now() + MODEL_CATALOG_CACHE_TTL_MS;
      logger.info(
        `[ModelManager] Model catalog refreshed: providers=${providers.length}, models=${valid.size}, providerIds=${providers.map((p) => p.id).join(",")}, copilot=removed, customProviders=coding-only`,
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
  const configured = getEnvDefaultModel();
  const valid = await getValidModelKeys();
  const env = configured && cachedModelsByProvider?.get(configured.providerID)?.some(m => m.modelID === configured.modelID) ? configured : null;
  try {
    const fs = await import("fs/promises");
    const state = JSON.parse(await fs.readFile(getOpenCodeModelStatePath(), "utf-8")) as OpenCodeModelState;
    const favorites = enrichModelNames(
      env
        ? dedupeModels([...filterModelsByCatalog(normalizeFavoriteModels(state), valid), env])
        : filterModelsByCatalog(normalizeFavoriteModels(state), valid),
    );
    const recent = enrichModelNames(filterModelsByCatalog(normalizeRecentModels(state), valid));
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
  const configuredFallback = getEnvDefaultModel();
  const fallback =
    configuredFallback && valid.has(getModelKey(configuredFallback.providerID, configuredFallback.modelID))
      ? configuredFallback
      : cachedAllModels?.find((model) => valid.has(getModelKey(model.providerID, model.modelID))) ?? null;
  if (fallback) {
    logger.warn(
      `[ModelManager] Stored model is unavailable or not tool-capable; falling back to ${getModelKey(fallback.providerID, fallback.modelID)}`,
    );
    setCurrentModel({ ...fallback, variant: "default" });
    const listener = modelFallbackListener;
    if (listener) {
      try {
        listener({
          previous: getModelKey(current.providerID, current.modelID),
          next: getModelKey(fallback.providerID, fallback.modelID),
          reason: "unavailable_or_not_tool_capable",
        });
      } catch (error) {
        logger.warn("[ModelManager] Model fallback listener failed:", error);
      }
    }
  }
}

export async function refreshModelCatalog(): Promise<void> {
  await getValidModelKeys({ force: true });
}

export function __resetModelCatalogCacheForTests() {
  cachedPriceMetadata.clear();
  cachedValidModelKeys = null;
  cachedAllModels = null;
  cachedProviders = null;
  cachedModelsByProvider = null;
  modelCatalogCacheExpiresAt = 0;
  modelCatalogFetchInFlight = null;
  modelFallbackListener = null;
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
  if (capability === "stt") {
    return customProviders.map((provider) => ({ id: provider.id, name: provider.name, modelCount: provider.models.length }));
  }
  if (capability === "image") {
    const { listImageModelCatalog } = await import("./image-model-catalog-service.js");
    const models = await listImageModelCatalog();
    const counts = new Map<string, { id: string; name: string; modelCount: number }>();
    for (const model of models) {
      const current = counts.get(model.providerID) ?? { id: model.providerID, name: model.providerName, modelCount: 0 };
      current.modelCount += 1;
      counts.set(model.providerID, current);
    }
    return [...counts.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  await getValidModelKeys();
  return cachedProviders ?? [];
}

export async function getProviderModels(providerID: string) {
  await getValidModelKeys();
  return cachedModelsByProvider?.get(providerID) ?? [];
}

export async function getProviderModelsForCapability(providerID: string, capability: AiCapability) {
  if (capability === "stt") {
    const provider = (await listCustomProvidersByCapability("stt")).find((item) => item.id === providerID);
    return provider?.models.map((model) => ({ providerID, modelID: model.id, name: model.name })) ?? [];
  }
  if (capability === "image") {
    const { listImageModelCatalog } = await import("./image-model-catalog-service.js");
    return (await listImageModelCatalog())
      .filter((model) => model.providerID === providerID)
      .map((model) => ({ providerID, modelID: model.modelID, name: model.modelName }));
  }

  await getValidModelKeys();
  return cachedModelsByProvider?.get(providerID) ?? [];
}

export async function resolveCatalogModel(providerID: string, modelID: string, options?: { forceRefresh?: boolean }): Promise<ModelInfo | null> {
  const valid = await getValidModelKeys({ force: options?.forceRefresh === true });
  if (!valid || !cachedAllModels) return null;
  const exact = cachedAllModels.find((model) => model.providerID === providerID && model.modelID === modelID);
  if (exact) {
    return await isSelectableChatModel(exact.providerID, exact.modelID)
      ? { ...exact, variant: "default" }
      : null;
  }
  const exactMatches = cachedAllModels.filter((model) => model.modelID === modelID);
  const match = exactMatches.length === 1 ? exactMatches[0] : undefined;
  if (!match || !(await isSelectableChatModel(match.providerID, match.modelID))) return null;
  return { ...match, variant: "default" };
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

export async function isSelectableChatModel(providerID: string, modelID: string): Promise<boolean> {
  const valid = await getValidModelKeys();
  const key = getModelKey(providerID, modelID);
  if (valid?.has(key)) return true;

  const customProvider = (await listCustomProviders()).find((provider) => provider.id === providerID);
  const customModel = customProvider?.models.find((model) => model.id === modelID);
  if (!customProvider || !customModel || customProvider.capability === "stt" || !isChatModelMetadata(customModel)) {
    return false;
  }

  if (!(await ensureCustomProviderModelToolCapability(providerID, modelID))) return false;
  const refreshed = await getValidModelKeys({ force: true });
  return refreshed?.has(key) ?? false;
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