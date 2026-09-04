import { listCustomProviders, getCustomProviderConfig, discoverModels, saveCustomProvider, syncOpenCodeCustomConfig } from "./custom-provider-service.js";
import { refreshModelCatalog } from "./model-selection-service.js";
import { logger } from "../../utils/logger.js";

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let refreshInFlight: Promise<void> | null = null;

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
        const previous = new Set(provider.models.map((model) => model.id));
        const next = new Set(discovered.map((model) => model.id));
        const same = previous.size === next.size && [...previous].every((id) => next.has(id));
        if (same) continue;
        await saveCustomProvider({ id: provider.id, name: provider.name, baseURL: config.apiUrl, apiKey: config.apiKey, models: discovered, capability: config.capability });
        changed = true;
        logger.info(`[ModelCatalog] Updated ${provider.id}: ${provider.models.length} -> ${discovered.length} models`);
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
