import { fetchProviderCatalog } from "./provider-catalog-service.js";
import {
  listCustomProviders,
  getCustomProviderConfig,
  normalizeDiscoveredModel,
  saveCustomProvider,
  syncOpenCodeCustomConfig,
  type CustomProviderModel,
} from "./custom-provider-service.js";
import { refreshModelCatalog } from "./model-selection-service.js";
import { logger } from "../../utils/logger.js";
import { opencodeClient } from "../../opencode/client.js";
import { config } from "../../config.js";
import { findServerPid, killServerProcess, resolveLocalOpencodeTarget, startLocalOpencodeServer } from "../../opencode/process.js";

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

function modelFingerprint(model: CustomProviderModel): string {
  return JSON.stringify([
    model.id,
    model.name,
    model.attachment ?? null,
    model.modalities?.input ?? [],
    model.modalities?.output ?? [],
  ]);
}

function modelsMatch(previous: CustomProviderModel[], next: CustomProviderModel[]): boolean {
  if (previous.length !== next.length) return false;
  const left = [...previous].sort((a, b) => a.id.localeCompare(b.id)).map(modelFingerprint);
  const right = [...next].sort((a, b) => a.id.localeCompare(b.id)).map(modelFingerprint);
  return left.every((value, index) => value === right[index]);
}

async function reloadLocalOpenCodeConfig(): Promise<boolean> {
  const target = resolveLocalOpencodeTarget(config.opencode.apiUrl);
  if (!target) return false;

  const pid = await findServerPid(target.port);
  if (pid) await killServerProcess(pid);
  await new Promise<void>((resolve) => setTimeout(resolve, 500));
  startLocalOpencodeServer(target).unref();
  return true;
}

export async function refreshAllCustomProviderModels(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    let changed = false;
    const providers = await listCustomProviders();

    for (const provider of providers) {
      try {
        const providerConfig = await getCustomProviderConfig(provider.id);
        if (!providerConfig) {
          logger.warn(`[ModelCatalog] Skipping ${provider.id}: API key unavailable`);
          continue;
        }

        // This is a real refresh, not a cached read. Custom providers can add or
        // remove short-lived/free models at any time, so the complete /models
        // response becomes the next catalog instead of intersecting it with the
        // models that happened to exist when the provider was first configured.
        const catalog = await fetchProviderCatalog(providerConfig.apiUrl, providerConfig.apiKey, { force: true });
        const discovered = catalog.records
          .map(normalizeDiscoveredModel)
          .filter((model): model is CustomProviderModel => Boolean(model));

        if (!discovered.length) {
          logger.warn(`[ModelCatalog] ${provider.id} returned no models; keeping last known catalog`);
          continue;
        }
        if (modelsMatch(provider.models, discovered)) continue;

        await saveCustomProvider({
          id: provider.id,
          name: provider.name,
          baseURL: providerConfig.apiUrl,
          apiKey: providerConfig.apiKey,
          models: discovered,
          capability: providerConfig.capability,
        });
        changed = true;
        logger.info(`[ModelCatalog] Updated ${provider.id}: ${provider.models.length} -> ${discovered.length} models`);
      } catch (error) {
        logger.warn(`[ModelCatalog] Failed to refresh provider ${provider.id}; keeping last known catalog`, error);
      }
    }

    if (changed) {
      const configPath = await syncOpenCodeCustomConfig();
      process.env.OPENCODE_CONFIG = configPath;
      try {
        if (await reloadLocalOpenCodeConfig()) {
          logger.info("[ModelCatalog] Reloaded local OpenCode after custom provider catalog change");
          return;
        }
      } catch (error) {
        logger.warn("[ModelCatalog] Custom provider catalog changed but OpenCode reload failed", error);
      }
    }

    if (await isOpenCodeReady()) {
      await refreshModelCatalog();
    } else {
      logger.debug("[ModelCatalog] OpenCode is not ready; deferring model catalog refresh until readiness callback");
    }
  })().finally(() => {
    refreshInFlight = null;
  });

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
