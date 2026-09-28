import { logger } from "../../utils/logger.js";
import { refreshFreeLlmCatalog } from "./free-llm-catalog-service.js";
import { syncOpenCodeCustomConfig } from "./custom-provider-service.js";
import { refreshModelCatalog } from "./model-selection-service.js";
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

export async function refreshAndStageFreeLlmCatalog(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const result = await refreshFreeLlmCatalog();
    if (!result.changed) {
      logger.debug("[FreeLLMCatalog] Public catalog unchanged; no config rewrite needed");
      return;
    }

    const configPath = await syncOpenCodeCustomConfig();
    process.env.OPENCODE_CONFIG = configPath;
    logger.info(
      "[FreeLLMCatalog] Public catalog changed; refreshed managed OpenCode config without interrupting the active server",
    );

    if (await isOpenCodeReady()) {
      await refreshModelCatalog();
    }
  })()
    .catch((error) => {
      logger.warn(
        "[FreeLLMCatalog] Scheduled public refresh failed; keeping last-known-good catalog and config",
        error,
      );
    })
    .finally(() => {
      refreshInFlight = null;
    });

  return refreshInFlight;
}

export function startFreeLlmCatalogRefreshService(): void {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    void refreshAndStageFreeLlmCatalog();
  }, REFRESH_INTERVAL_MS);
  refreshTimer.unref?.();
  logger.info(
    `[FreeLLMCatalog] Live public registry refresh enabled: every ${REFRESH_INTERVAL_MS / 60000} minutes`,
  );
}

export function stopFreeLlmCatalogRefreshService(): void {
  if (!refreshTimer) return;
  clearInterval(refreshTimer);
  refreshTimer = null;
}

export function __resetFreeLlmCatalogRefreshForTests(): void {
  stopFreeLlmCatalogRefreshService();
  refreshInFlight = null;
}
