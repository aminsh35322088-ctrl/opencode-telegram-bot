import { logger } from "../../utils/logger.js";
import { refreshFreeLlmCatalog } from "./free-llm-catalog-service.js";
import { syncOpenCodeCustomConfig } from "./custom-provider-service.js";
import { refreshModelCatalog } from "./model-selection-service.js";
import { opencodeClient } from "../../opencode/client.js";

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

let refreshTimer: ReturnType<typeof setInterval> | null = null;
let refreshInFlight: Promise<void> | null = null;
let runtimeReloadPending = false;

async function isOpenCodeReady(): Promise<boolean> {
  try {
    const { data, error } = await opencodeClient.global.health();
    return !error && data?.healthy === true;
  } catch {
    return false;
  }
}

async function isSafeToReloadOpenCode(): Promise<boolean> {
  try {
    const {
      getOpenCodeActivityState,
      isAnyForegroundBusy,
      reconcileAllForegroundBusyState,
    } = await import("./run-control-service.js");
    const { scheduledTaskRuntime } = await import("./scheduled-task-runtime-service.js");
    await reconcileAllForegroundBusyState();
    if (isAnyForegroundBusy() || scheduledTaskRuntime.hasRunningTasks()) return false;
    return await getOpenCodeActivityState() === "idle";
  } catch (error) {
    logger.debug("[FreeLLMCatalog] Could not verify idle state for catalog reload", error);
    return false;
  }
}

async function applyPendingRuntimeReload(): Promise<void> {
  if (!runtimeReloadPending) return;
  if (!(await isOpenCodeReady())) return;
  if (!(await isSafeToReloadOpenCode())) {
    logger.debug("[FreeLLMCatalog] Runtime reload deferred until OpenCode is idle");
    return;
  }

  const { error } = await opencodeClient.global.dispose();
  if (error) throw error;
  runtimeReloadPending = false;
  logger.info("[FreeLLMCatalog] Reloaded idle OpenCode instances with refreshed public catalog");
  await refreshModelCatalog();
}

export async function refreshAndStageFreeLlmCatalog(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const result = await refreshFreeLlmCatalog();
    if (result.changed) {
      const configPath = await syncOpenCodeCustomConfig();
      process.env.OPENCODE_CONFIG = configPath;
      runtimeReloadPending = true;
      logger.info(
        "[FreeLLMCatalog] Public catalog changed; refreshed managed OpenCode config and queued an idle runtime reload",
      );
    } else {
      logger.debug("[FreeLLMCatalog] Public catalog unchanged");
    }

    await applyPendingRuntimeReload();
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
  runtimeReloadPending = false;
}
