import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  healthMock: vi.fn(),
  warmupSessionDirectoryCacheMock: vi.fn(),
  reconcileStoredModelSelectionMock: vi.fn(),
  restoreSecureMcpConnectionsMock: vi.fn(),
  loggerDebugMock: vi.fn(),
  loggerWarnMock: vi.fn(),
}));

vi.mock("../../src/opencode/client.js", () => ({
  opencodeClient: {
    global: {
      health: mocked.healthMock,
    },
  },
}));

vi.mock("../../src/app/services/session-cache-service.js", () => ({
  __resetSessionDirectoryCacheForTests: vi.fn(),
  warmupSessionDirectoryCache: mocked.warmupSessionDirectoryCacheMock,
}));

vi.mock("../../src/app/services/model-selection-service.js", () => ({
  reconcileStoredModelSelection: mocked.reconcileStoredModelSelectionMock,
}));

vi.mock("../../src/app/services/mcp-server-service.js", () => ({
  restoreSecureMcpConnections: mocked.restoreSecureMcpConnectionsMock,
}));

vi.mock("../../src/utils/logger.js", () => ({
  logger: {
    debug: mocked.loggerDebugMock,
    info: vi.fn(),
    warn: mocked.loggerWarnMock,
    error: vi.fn(),
  },
}));

import {
  refreshSessionCacheAfterOpencodeReady,
  refreshSessionCacheIfOpencodeReady,
  waitForOpencodeReadyAndRefresh,
} from "../../src/opencode/ready-refresh.js";

describe("opencode/ready-refresh", () => {
  beforeEach(() => {
    mocked.healthMock.mockReset();
    mocked.warmupSessionDirectoryCacheMock.mockReset();
    mocked.reconcileStoredModelSelectionMock.mockReset();
    mocked.restoreSecureMcpConnectionsMock.mockReset();
    mocked.loggerDebugMock.mockReset();
    mocked.loggerWarnMock.mockReset();

    mocked.warmupSessionDirectoryCacheMock.mockResolvedValue(undefined);
    mocked.reconcileStoredModelSelectionMock.mockResolvedValue(undefined);
    mocked.restoreSecureMcpConnectionsMock.mockResolvedValue({ restored: 0, failed: 0 });
  });

  it("skips refresh with a short warning when OpenCode server is unavailable", async () => {
    mocked.healthMock.mockRejectedValueOnce(new Error("fetch failed"));

    const refreshed = await refreshSessionCacheIfOpencodeReady("startup");

    expect(refreshed).toBe(false);
    expect(mocked.warmupSessionDirectoryCacheMock).not.toHaveBeenCalled();
    expect(mocked.reconcileStoredModelSelectionMock).not.toHaveBeenCalled();
    expect(mocked.restoreSecureMcpConnectionsMock).not.toHaveBeenCalled();
    expect(mocked.loggerWarnMock).toHaveBeenCalledWith(
      "[OpenCodeReady] OpenCode server is not running; skipping session cache refresh: reason=startup",
    );
  });

  it("refreshes cache when OpenCode server is healthy", async () => {
    mocked.healthMock.mockResolvedValueOnce({ data: { healthy: true }, error: null });

    const refreshed = await refreshSessionCacheIfOpencodeReady("startup");

    expect(refreshed).toBe(true);
    expect(mocked.warmupSessionDirectoryCacheMock).toHaveBeenCalledTimes(1);
    expect(mocked.reconcileStoredModelSelectionMock).toHaveBeenCalledWith({
      forceCatalogRefresh: true,
    });
    expect(mocked.restoreSecureMcpConnectionsMock).toHaveBeenCalledTimes(1);
  });

  it("logs refresh failures without throwing", async () => {
    mocked.warmupSessionDirectoryCacheMock.mockRejectedValueOnce(new Error("refresh failed"));

    await expect(
      refreshSessionCacheAfterOpencodeReady("opencode_start_success"),
    ).resolves.toBeUndefined();

    expect(mocked.loggerWarnMock).toHaveBeenCalledWith(
      "[OpenCodeReady] Failed to refresh session cache: reason=opencode_start_success",
      expect.any(Error),
    );
    expect(mocked.reconcileStoredModelSelectionMock).toHaveBeenCalledWith({
      forceCatalogRefresh: true,
    });
  });

  it("logs model refresh failures without throwing", async () => {
    mocked.reconcileStoredModelSelectionMock.mockRejectedValueOnce(new Error("model failed"));

    await expect(
      refreshSessionCacheAfterOpencodeReady("opencode_start_success"),
    ).resolves.toBeUndefined();

    expect(mocked.loggerWarnMock).toHaveBeenCalledWith(
      "[OpenCodeReady] Failed to refresh model catalog: reason=opencode_start_success",
      expect.any(Error),
    );
  });
  it("restores secure MCP definitions whenever OpenCode becomes ready", async () => {
    mocked.restoreSecureMcpConnectionsMock.mockResolvedValueOnce({ restored: 2, failed: 0 });

    await refreshSessionCacheAfterOpencodeReady("auto_restart_startup");

    expect(mocked.restoreSecureMcpConnectionsMock).toHaveBeenCalledTimes(1);
    expect(mocked.loggerDebugMock).toHaveBeenCalledWith(
      "[OpenCodeReady] Secure MCP connections restored: reason=auto_restart_startup, restored=2, failed=0",
    );
  });

  it("does not fail ready handling when secure MCP restoration fails", async () => {
    mocked.restoreSecureMcpConnectionsMock.mockRejectedValueOnce(new Error("credential restore failed"));

    await expect(
      refreshSessionCacheAfterOpencodeReady("auto_restart_interval"),
    ).resolves.toBeUndefined();

    expect(mocked.loggerWarnMock).toHaveBeenCalledWith(
      "[OpenCodeReady] Failed to restore secure MCP connections: reason=auto_restart_interval",
      expect.any(Error),
    );
    expect(mocked.reconcileStoredModelSelectionMock).toHaveBeenCalledWith({
      forceCatalogRefresh: true,
    });
  });


  it("waits for a restarted OpenCode server and then restores secure MCP runtime state", async () => {
    mocked.healthMock
      .mockResolvedValueOnce({ data: { healthy: false }, error: null })
      .mockResolvedValueOnce({ data: { healthy: true }, error: null });

    const refreshed = await waitForOpencodeReadyAndRefresh("provider_change", {
      timeoutMs: 50,
      pollIntervalMs: 1,
    });

    expect(refreshed).toBe(true);
    expect(mocked.healthMock).toHaveBeenCalledTimes(2);
    expect(mocked.restoreSecureMcpConnectionsMock).toHaveBeenCalledTimes(1);
    expect(mocked.reconcileStoredModelSelectionMock).toHaveBeenCalledWith({
      forceCatalogRefresh: true,
    });
  });

  it("returns false without restoring runtime state when a restarted server never becomes healthy", async () => {
    mocked.healthMock.mockResolvedValue({ data: { healthy: false }, error: null });

    const refreshed = await waitForOpencodeReadyAndRefresh("provider_change", {
      timeoutMs: 3,
      pollIntervalMs: 1,
    });

    expect(refreshed).toBe(false);
    expect(mocked.restoreSecureMcpConnectionsMock).not.toHaveBeenCalled();
  });

});
