import { reconcileStoredModelSelection } from "../app/services/model-selection-service.js";
import { restoreSecureMcpConnections } from "../app/services/mcp-catalog-service.js";
import { warmupSessionDirectoryCache } from "../app/services/session-cache-service.js";
import { logger } from "../utils/logger.js";
import { opencodeClient } from "./client.js";
import { opencodeReadyLifecycle } from "./ready-lifecycle.js";

let readyRefreshRegistered = false;

export async function isOpencodeServerHealthy(): Promise<boolean> {
  try {
    const { data, error } = await opencodeClient.global.health();
    return !error && data?.healthy === true;
  } catch {
    return false;
  }
}

export async function refreshSessionCacheAfterOpencodeReady(reason: string): Promise<void> {
  try {
    const restored = await restoreSecureMcpConnections();
    logger.debug(
      `[OpenCodeReady] Secure MCP connections restored: reason=${reason}, restored=${restored.restored}, failed=${restored.failed}`,
    );
  } catch (error) {
    logger.warn(`[OpenCodeReady] Failed to restore secure MCP connections: reason=${reason}`, error);
  }

  try {
    await warmupSessionDirectoryCache();
    logger.debug(`[OpenCodeReady] Session cache refreshed: reason=${reason}`);
  } catch (error) {
    logger.warn(`[OpenCodeReady] Failed to refresh session cache: reason=${reason}`, error);
  }

  try {
    await reconcileStoredModelSelection({ forceCatalogRefresh: true });
    logger.debug(`[OpenCodeReady] Model catalog refreshed: reason=${reason}`);
  } catch (error) {
    logger.warn(`[OpenCodeReady] Failed to refresh model catalog: reason=${reason}`, error);
  }
}

export async function refreshSessionCacheIfOpencodeReady(reason: string): Promise<boolean> {
  if (!(await isOpencodeServerHealthy())) {
    opencodeReadyLifecycle.notifyUnavailable(reason);
    logger.warn(
      `[OpenCodeReady] OpenCode server is not running; skipping session cache refresh: reason=${reason}`,
    );
    return false;
  }

  await refreshSessionCacheAfterOpencodeReady(reason);
  return true;
}

export async function waitForOpencodeReadyAndRefresh(
  reason: string,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    if (await isOpencodeServerHealthy()) {
      await refreshSessionCacheAfterOpencodeReady(reason);
      return true;
    }

    if (Date.now() - startedAt >= timeoutMs) break;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  logger.warn(
    `[OpenCodeReady] Timed out waiting for OpenCode after restart: reason=${reason}, timeoutMs=${timeoutMs}`,
  );
  return false;
}

export function registerOpenCodeReadyRefreshHandler(): void {
  if (readyRefreshRegistered) {
    return;
  }

  readyRefreshRegistered = true;
  opencodeReadyLifecycle.onReady((reason) => refreshSessionCacheAfterOpencodeReady(reason));
}

export async function notifyOpencodeReadyIfHealthy(reason: string): Promise<boolean> {
  if (!(await isOpencodeServerHealthy())) {
    opencodeReadyLifecycle.notifyUnavailable(reason);
    logger.warn(`[OpenCodeReady] OpenCode server is not running: reason=${reason}`);
    return false;
  }

  return opencodeReadyLifecycle.notifyReady(reason);
}
