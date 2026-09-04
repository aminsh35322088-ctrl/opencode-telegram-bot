import { listCustomProviders, getCustomProviderConfig, discoverModels, saveCustomProvider, syncOpenCodeCustomConfig } from "./custom-provider-service.js";
import { refreshModelCatalog } from "./model-selection-service.js";
import { logger } from "../../utils/logger.js";
import { opencodeClient } from "../../opencode/client.js";

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let refreshInFlight: Promise<void> | null = null;

async function isOpenCodeReady(): Promise<boolean> {
  try {
    const { data, error } = await opencodeClient.global.health();
    return !error && data?.healthy === true;
  } catch {
    return false;
  }
}

function modelsMatch(previous: Array<{ id: string; name: string }>, next: Array<{ id: string; name: string }>): boolean {
  if (previous.length !== next.length) return false;
  const nextById = new Map(next.map((model) => [model.id, model.name]));
  return previous.every((model) => nextById.get(model.id) === model.name);
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
        const configuredIds = new Set(provider.models.map((model) => model.id));
        const next = discovered.filter((model) => configuredIds.has(model.id));
        if (!next.length) {
          logger.warn(`[ModelCatalog] ${provider.id} returned no configured models; keeping last known catalog`);
          continue;
        }
        if (modelsMatch(provider.models, next)) continue;
        await saveCustomProvider({
          id: provider.id,
          name: provider.name,
          baseURL: config.apiUrl,
          apiKey: config.apiKey,
          models: next,
          capability: config.capability,
        });
        changed = true;
        logger.info(`[ModelCatalog] Updated ${provider.id}: ${provider.models.length} -> ${next.length} models`);
      } catch (error) {
        logger.warn(`[ModelCatalog] Failed to refresh provider ${provider.id}; keeping last known catalog`, error);
      }
    }
    if (changed) await syncOpenCodeCustomConfig();
    if (await isOpenCodeReady()) {
      await refreshModelCatalog();
    } else {
      logger.debug("[ModelCatalog] OpenCode is not ready; deferring model catalog refresh until readiness callback");
    }
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
