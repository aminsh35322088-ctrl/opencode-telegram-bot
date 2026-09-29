import { logger } from "../../utils/logger.js";
import { buildFreeLlmOpenCodeProviders, refreshFreeLlmCatalog } from "./free-llm-catalog-service.js";
import { syncOpenCodeCustomConfig } from "./custom-provider-service.js";
import { refreshModelCatalog } from "./model-selection-service.js";
import { opencodeClient } from "../../opencode/client.js";
import { opencodeAutoRestartService } from "../../opencode/auto-restart.js";

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

export async function verifyFreeLlmRuntimeRegistration(): Promise<boolean> {
  const expected = await buildFreeLlmOpenCodeProviders();
  const expectedProviderIds = Object.keys(expected).sort();
  if (!expectedProviderIds.length) return true;

  const { data, error } = await opencodeClient.config.providers();
  if (error || !data) {
    logger.warn("[FreeLLMCatalog] Could not verify runtime provider registration", error);
    return false;
  }

  const actual = new Map(
    data.providers.map((provider) => [provider.id, new Set(Object.keys(provider.models ?? {}))]),
  );
  const missingProviders: string[] = [];
  const missingModels: string[] = [];

  for (const providerId of expectedProviderIds) {
    const configured = expected[providerId] as { models?: Record<string, unknown> } | undefined;
    const runtimeModels = actual.get(providerId);
    if (!runtimeModels) {
      missingProviders.push(providerId);
      continue;
    }
    for (const modelId of Object.keys(configured?.models ?? {})) {
      if (!runtimeModels.has(modelId)) missingModels.push(`${providerId}/${modelId}`);
    }
  }

  if (missingProviders.length || missingModels.length) {
    logger.warn(
      `[FreeLLMCatalog] Runtime registration mismatch: missingProviders=${missingProviders.join(",") || "none"}, missingModels=${missingModels.length}`,
    );
    return false;
  }

  logger.info(
    `[FreeLLMCatalog] Runtime registration verified: providers=${expectedProviderIds.join(",")}, models=${expectedProviderIds.reduce((count, id) => count + Object.keys((expected[id] as { models?: Record<string, unknown> } | undefined)?.models ?? {}).length, 0)}`,
  );
  return true;
}

async function applyPendingRuntimeReload(): Promise<void> {
  if (!runtimeReloadPending) return;
  if (!(await isOpenCodeReady())) return;
  if (!(await isSafeToReloadOpenCode())) {
    logger.debug("[FreeLLMCatalog] Runtime reload deferred until OpenCode is idle");
    return;
  }

  const restarted = await opencodeAutoRestartService.restartForConfigChange("free_llm_catalog");
  if (!restarted) {
    logger.warn("[FreeLLMCatalog] Managed config was staged but OpenCode process restart could not be completed");
    return;
  }

  const verified = await verifyFreeLlmRuntimeRegistration();
  if (!verified) {
    logger.warn("[FreeLLMCatalog] Keeping runtime reload pending because provider registration is incomplete");
    return;
  }

  runtimeReloadPending = false;
  logger.info("[FreeLLMCatalog] Applied refreshed public catalog to the live OpenCode runtime");
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
