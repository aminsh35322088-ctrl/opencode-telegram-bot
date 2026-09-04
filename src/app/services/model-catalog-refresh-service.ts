import { listCustomProviders, getCustomProviderConfig, discoverModels, saveCustomProvider, syncOpenCodeCustomConfig } from "./custom-provider-service.js";
import { refreshModelCatalog } from "./model-selection-service.js";
import { logger } from "../../utils/logger.js";

type CatalogModel = Awaited<ReturnType<typeof discoverModels>>[number];

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let refreshInFlight: Promise<void> | null = null;

function sameModelMetadata(a: CatalogModel, b: CatalogModel): boolean {
  return a.id === b.id
    && a.name === b.name
    && a.freeStatus === b.freeStatus
    && a.freeConfidence === b.freeConfidence
    && a.freeSource === b.freeSource
    && a.freeReason === b.freeReason
    && JSON.stringify(a.pricing ?? null) === JSON.stringify(b.pricing ?? null);
}

function catalogsEqual(previous: CatalogModel[], next: CatalogModel[]): boolean {
  if (previous.length !== next.length) return false;
  const previousById = new Map(previous.map((model) => [model.id, model]));
  return next.every((model) => {
    const previousModel = previousById.get(model.id);
    return previousModel ? sameModelMetadata(previousModel, model) : false;
  });
}

export async function refreshAllCustomProviderModels(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    let changed = false;
    const providers = await listCustomProviders();
    for (const provider of providers) {
      try {
        const config = await getCustomProviderConfig(provider.id);
        if (!config) {
          logger.warn(`[ModelCatalog] Skipping ${provider.id}: API key unavailable`);
          continue;
        }
        const discovered = await discoverModels(config.apiUrl, config.apiKey);
        if (catalogsEqual(provider.models, discovered)) continue;
        await saveCustomProvider({ id: provider.id, name: provider.name, baseURL: config.apiUrl, apiKey: config.apiKey, models: discovered, capability: config.capability });
        changed = true;
        const previousFree = provider.models.filter((model) => model.freeStatus === "free" && model.freeConfidence === "high").length;
        const nextFree = discovered.filter((model) => model.freeStatus === "free" && model.freeConfidence === "high").length;
        logger.info(`[ModelCatalog] Updated ${provider.id}: ${provider.models.length} -> ${discovered.length} models, verifiedFree=${previousFree} -> ${nextFree}`);
      } catch (error) {
        logger.warn(`[ModelCatalog] Failed to refresh provider ${provider.id}; keeping last known catalog`, error);
      }
    }
    if (changed) await syncOpenCodeCustomConfig();
    await refreshModelCatalog();
  })().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

export function startModelCatalogRefreshService(): void {
  if (refreshTimer) return;
  void refreshAllCustomProviderModels().catch((error) => logger.warn("[ModelCatalog] Initial refresh failed", error));
  refreshTimer = setInterval(() => {
    void refreshAllCustomProviderModels().catch((error) => logger.warn("[ModelCatalog] Scheduled refresh failed", error));
  }, REFRESH_INTERVAL_MS);
  refreshTimer.unref?.();
  logger.info(`[ModelCatalog] Automatic provider model refresh enabled: every ${REFRESH_INTERVAL_MS / 60000} minutes`);
}

export function stopModelCatalogRefreshService(): void {
  if (!refreshTimer) return;
  clearInterval(refreshTimer);
  refreshTimer = null;
}

export function __catalogsEqualForTests(previous: CatalogModel[], next: CatalogModel[]): boolean {
  return catalogsEqual(previous, next);
}
