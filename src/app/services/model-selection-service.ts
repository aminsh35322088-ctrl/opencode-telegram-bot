import { getCurrentModel, setCurrentModel } from "../stores/settings-store.js";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";
import type {
  FavoriteModel,
  ModelInfo,
  ModelSelectionLists,
  ProviderInfo,
} from "../types/model.js";
import path from "node:path";
import {
  listCustomProvidersByCapability,
  type AiCapability,
} from "./custom-provider-service.js";
import {
  __resetUnifiedModelCatalogForTests,
  ensureUnifiedAgentModelReady,
  getUnifiedRuntimePriceMetadata,
  listUnifiedAgentCandidates,
  listUnifiedAgentModels,
  listUnifiedAgentProviders,
  listUnifiedAgentReadyRefs,
  refreshUnifiedModelCatalog,
} from "./unified-model-catalog-service.js";

interface OpenCodeModelState {
  favorite?: Array<{ providerID?: string; modelID?: string }>;
  recent?: Array<{ providerID?: string; modelID?: string }>;
}

const SEARCH_RESULTS_LIMIT = 10;

export interface ModelFallbackEvent {
  previous: string;
  next: string;
  reason: "unavailable_or_not_tool_capable";
}

type ModelFallbackListener = (event: ModelFallbackEvent) => void;
let modelFallbackListener: ModelFallbackListener | null = null;

export function setModelFallbackListener(
  listener: ModelFallbackListener | null,
): void {
  modelFallbackListener = listener;
}

function getModelKey(providerID: string, modelID: string): string {
  return providerID + "/" + modelID;
}

function getEnvDefaultModel(): FavoriteModel | null {
  const providerID = config.opencode.model.provider;
  const modelID = config.opencode.model.modelId;
  return providerID && modelID ? { providerID, modelID } : null;
}

function dedupeModels(models: FavoriteModel[]): FavoriteModel[] {
  const unique = new Map<string, FavoriteModel>();

  for (const model of models) {
    const modelKey = getModelKey(model.providerID, model.modelID);
    const existing = unique.get(modelKey);

    if (!existing) {
      unique.set(modelKey, model);
    } else if (!existing.name && model.name) {
      unique.set(modelKey, { ...existing, name: model.name });
    }
  }

  return [...unique.values()];
}

function normalizeFavoriteModels(
  state: OpenCodeModelState,
): FavoriteModel[] {
  return Array.isArray(state.favorite)
    ? state.favorite
        .filter(
          (
            model,
          ): model is { providerID: string; modelID: string } =>
            typeof model?.providerID === "string" &&
            Boolean(model.providerID) &&
            typeof model.modelID === "string" &&
            Boolean(model.modelID),
        )
        .map((model) => ({
          providerID: model.providerID,
          modelID: model.modelID,
        }))
    : [];
}

function normalizeRecentModels(state: OpenCodeModelState): FavoriteModel[] {
  return Array.isArray(state.recent)
    ? state.recent
        .filter(
          (
            model,
          ): model is { providerID: string; modelID: string } =>
            typeof model?.providerID === "string" &&
            Boolean(model.providerID) &&
            typeof model.modelID === "string" &&
            Boolean(model.modelID),
        )
        .map((model) => ({
          providerID: model.providerID,
          modelID: model.modelID,
        }))
    : [];
}

function getOpenCodeModelStatePath(): string {
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg?.trim()) {
    return path.join(xdg, "opencode", "model.json");
  }

  const home = process.env.HOME || process.env.USERPROFILE || "";
  return path.join(home, ".local", "state", "opencode", "model.json");
}

function enrichNames(
  models: FavoriteModel[],
  candidates: FavoriteModel[],
): FavoriteModel[] {
  const names = new Map(
    candidates.map((model) => [
      getModelKey(model.providerID, model.modelID),
      model.name,
    ]),
  );

  return models.map((model) => {
    const name = names.get(
      getModelKey(model.providerID, model.modelID),
    );
    return name ? { ...model, name } : model;
  });
}

function filterReady(
  models: FavoriteModel[],
  ready: Set<string>,
): FavoriteModel[] {
  return models.filter((model) =>
    ready.has(getModelKey(model.providerID, model.modelID)),
  );
}

export function getCachedProviderPriceMetadata(providerID: string) {
  return getUnifiedRuntimePriceMetadata(providerID);
}

export async function getModelSelectionLists(): Promise<ModelSelectionLists> {
  const [readyModels, candidates] = await Promise.all([
    listUnifiedAgentReadyRefs(),
    listUnifiedAgentCandidates(),
  ]);

  const ready = new Set(
    readyModels.map((model) =>
      getModelKey(model.providerID, model.modelID),
    ),
  );

  const candidateRefs = candidates.map((entry) => ({
    providerID: entry.providerID,
    modelID: entry.modelID,
    ...(entry.modelName !== entry.modelID
      ? { name: entry.modelName }
      : {}),
  }));

  const configured = getEnvDefaultModel();
  const env =
    configured &&
    ready.has(
      getModelKey(configured.providerID, configured.modelID),
    )
      ? configured
      : null;

  try {
    const fs = await import("fs/promises");
    const state = JSON.parse(
      await fs.readFile(getOpenCodeModelStatePath(), "utf-8"),
    ) as OpenCodeModelState;

    const favorites = enrichNames(
      env
        ? dedupeModels([
            ...filterReady(normalizeFavoriteModels(state), ready),
            env,
          ])
        : filterReady(normalizeFavoriteModels(state), ready),
      candidateRefs,
    );

    const recent = enrichNames(
      filterReady(normalizeRecentModels(state), ready),
      candidateRefs,
    );

    const favoriteKeys = new Set(
      favorites.map((model) =>
        getModelKey(model.providerID, model.modelID),
      ),
    );

    return {
      favorites,
      recent: dedupeModels(recent).filter(
        (model) =>
          !favoriteKeys.has(
            getModelKey(model.providerID, model.modelID),
          ),
      ),
    };
  } catch (error) {
    if (env) return { favorites: [env], recent: [] };

    logger.warn(
      "[ModelManager] OpenCode model state unavailable; returning empty favorites/recent:",
      error,
    );

    return { favorites: [], recent: [] };
  }
}

export async function reconcileStoredModelSelection(options?: {
  forceCatalogRefresh?: boolean;
}): Promise<void> {
  if (options?.forceCatalogRefresh) {
    await refreshUnifiedModelCatalog();
  }

  const current = getCurrentModel();
  if (!current?.providerID || !current.modelID) return;

  let readyModels = await listUnifiedAgentReadyRefs();
  let ready = new Set(
    readyModels.map((model) =>
      getModelKey(model.providerID, model.modelID),
    ),
  );

  const currentKey = getModelKey(
    current.providerID,
    current.modelID,
  );

  if (ready.has(currentKey)) return;

  if (
    await ensureUnifiedAgentModelReady(
      current.providerID,
      current.modelID,
    )
  ) {
    return;
  }

  readyModels = await listUnifiedAgentReadyRefs();
  ready = new Set(
    readyModels.map((model) =>
      getModelKey(model.providerID, model.modelID),
    ),
  );

  const configuredFallback = getEnvDefaultModel();
  const fallback =
    configuredFallback &&
    ready.has(
      getModelKey(
        configuredFallback.providerID,
        configuredFallback.modelID,
      ),
    )
      ? configuredFallback
      : readyModels[0] ?? null;

  if (!fallback) return;

  logger.warn(
    "[ModelManager] Stored model is unavailable or not tool-capable; falling back to " +
      getModelKey(fallback.providerID, fallback.modelID),
  );

  setCurrentModel({ ...fallback, variant: "default" });

  const listener = modelFallbackListener;
  if (!listener) return;

  try {
    listener({
      previous: currentKey,
      next: getModelKey(
        fallback.providerID,
        fallback.modelID,
      ),
      reason: "unavailable_or_not_tool_capable",
    });
  } catch (error) {
    logger.warn(
      "[ModelManager] Model fallback listener failed:",
      error,
    );
  }
}

export async function refreshModelCatalog(): Promise<void> {
  await refreshUnifiedModelCatalog();
}

export function __resetModelCatalogCacheForTests(): void {
  __resetUnifiedModelCatalogForTests();
  modelFallbackListener = null;
}

export async function getFavoriteModels(): Promise<FavoriteModel[]> {
  return (await getModelSelectionLists()).favorites;
}

export async function getProviders(): Promise<ProviderInfo[]> {
  return listUnifiedAgentProviders();
}

export async function getProvidersForCapability(
  capability: AiCapability,
): Promise<ProviderInfo[]> {
  const customProviders =
    await listCustomProvidersByCapability(capability);

  if (capability === "stt") {
    return customProviders.map((provider) => ({
      id: provider.id,
      name: provider.name,
      modelCount: provider.models.length,
    }));
  }

  if (capability === "image") {
    const { listImageModelCatalog } =
      await import("./image-model-catalog-service.js");

    const models = await listImageModelCatalog();
    const counts = new Map<string, ProviderInfo>();

    for (const model of models) {
      const current = counts.get(model.providerID) ?? {
        id: model.providerID,
        name: model.providerName,
        modelCount: 0,
      };
      current.modelCount += 1;
      counts.set(model.providerID, current);
    }

    return [...counts.values()].sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );
  }

  return listUnifiedAgentProviders();
}

export async function getProviderModels(
  providerID: string,
): Promise<FavoriteModel[]> {
  return listUnifiedAgentModels(providerID);
}

export async function getProviderModelsForCapability(
  providerID: string,
  capability: AiCapability,
): Promise<FavoriteModel[]> {
  if (capability === "stt") {
    const provider = (
      await listCustomProvidersByCapability("stt")
    ).find((item) => item.id === providerID);

    return (
      provider?.models.map((model) => ({
        providerID,
        modelID: model.id,
        name: model.name,
      })) ?? []
    );
  }

  if (capability === "image") {
    const { listImageModelCatalog } =
      await import("./image-model-catalog-service.js");

    return (await listImageModelCatalog())
      .filter((model) => model.providerID === providerID)
      .map((model) => ({
        providerID,
        modelID: model.modelID,
        name: model.modelName,
      }));
  }

  return listUnifiedAgentModels(providerID);
}

export async function resolveCatalogModel(
  providerID: string,
  modelID: string,
  options?: { forceRefresh?: boolean },
): Promise<ModelInfo | null> {
  if (options?.forceRefresh) {
    await refreshUnifiedModelCatalog();
  }

  const candidates = await listUnifiedAgentCandidates();

  const exact = candidates.find(
    (model) =>
      model.providerID === providerID &&
      model.modelID === modelID,
  );

  if (exact) {
    return (await ensureUnifiedAgentModelReady(
      exact.providerID,
      exact.modelID,
    ))
      ? {
          providerID: exact.providerID,
          modelID: exact.modelID,
          name: exact.modelName,
          variant: "default",
        }
      : null;
  }

  const matches = candidates.filter(
    (model) => model.modelID === modelID,
  );

  if (matches.length !== 1) return null;

  const match = matches[0]!;
  return (await ensureUnifiedAgentModelReady(
    match.providerID,
    match.modelID,
  ))
    ? {
        providerID: match.providerID,
        modelID: match.modelID,
        name: match.modelName,
        variant: "default",
      }
    : null;
}

export async function searchModels(
  query: string,
): Promise<FavoriteModel[]> {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];

  return (await listUnifiedAgentCandidates())
    .filter((model) =>
      (model.modelID + " " + model.modelName)
        .toLowerCase()
        .includes(normalized),
    )
    .slice(0, SEARCH_RESULTS_LIMIT)
    .map((model) => ({
      providerID: model.providerID,
      modelID: model.modelID,
      ...(model.modelName !== model.modelID
        ? { name: model.modelName }
        : {}),
    }));
}

export async function isSelectableChatModel(
  providerID: string,
  modelID: string,
): Promise<boolean> {
  return ensureUnifiedAgentModelReady(providerID, modelID);
}

export function fetchCurrentModel(): ModelInfo {
  return getStoredModel();
}

export function selectModel(modelInfo: ModelInfo): void {
  logger.info(
    "[ModelManager] Selected model: " +
      modelInfo.providerID +
      "/" +
      modelInfo.modelID,
  );
  setCurrentModel(modelInfo);
}

export function getStoredModel(): ModelInfo {
  const stored = getCurrentModel();

  if (stored) {
    if (!stored.variant) stored.variant = "default";
    return stored;
  }

  if (
    config.opencode.model.provider &&
    config.opencode.model.modelId
  ) {
    return {
      providerID: config.opencode.model.provider,
      modelID: config.opencode.model.modelId,
      variant: "default",
    };
  }

  return {
    providerID: "",
    modelID: "",
    variant: "default",
  };
}
