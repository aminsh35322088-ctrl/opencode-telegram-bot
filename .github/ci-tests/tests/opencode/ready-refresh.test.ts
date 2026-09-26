import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  healthMock: vi.fn(),
  warmupSessionDirectoryCacheMock: vi.fn(),
  reconcileAllStoredModelSelectionsMock: vi.fn(),
  restoreMcpRuntimeMock: vi.fn(),
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
  reconcileAllStoredModelSelections: mocked.reconcileAllStoredModelSelectionsMock,
}));

vi.mock("../../src/app/services/mcp-server-service.js", () => ({
  restoreMcpRuntime: mocked.restoreMcpRuntimeMock,
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
    mocked.reconcileAllStoredModelSelectionsMock.mockReset();
    mocked.restoreMcpRuntimeMock.mockReset();
    mocked.loggerDebugMock.mockReset();
    mocked.loggerWarnMock.mockReset();

    mocked.warmupSessionDirectoryCacheMock.mockResolvedValue(undefined);
    mocked.reconcileAllStoredModelSelectionsMock.mockResolvedValue(undefined);
    mocked.restoreMcpRuntimeMock.mockResolvedValue({ managed: { restored: 0, failed: 0 }, secure: { restored: 0, failed: 0 } });
  });

  it("skips refresh with a short warning when OpenCode server is unavailable", async () => {
    mocked.healthMock.mockRejectedValueOnce(new Error("fetch failed"));

    const refreshed = await refreshSessionCacheIfOpencodeReady("startup");

    expect(refreshed).toBe(false);
    expect(mocked.warmupSessionDirectoryCacheMock).not.toHaveBeenCalled();
    expect(mocked.reconcileAllStoredModelSelectionsMock).not.toHaveBeenCalled();
    expect(mocked.restoreMcpRuntimeMock).not.toHaveBeenCalled();
    expect(mocked.loggerWarnMock).toHaveBeenCalledWith(
      "[OpenCodeReady] OpenCode server is not running; skipping session cache refresh: reason=startup",
    );
  });

  it("refreshes cache when OpenCode server is healthy", async () => {
    mocked.healthMock.mockResolvedValueOnce({ data: { healthy: true }, error: null });

    const refreshed = await refreshSessionCacheIfOpencodeReady("startup");

    expect(refreshed).toBe(true);
    expect(mocked.warmupSessionDirectoryCacheMock).toHaveBeenCalledTimes(1);
    expect(mocked.reconcileAllStoredModelSelectionsMock).toHaveBeenCalledWith({
      forceCatalogRefresh: true,
    });
    expect(mocked.restoreMcpRuntimeMock).toHaveBeenCalledTimes(1);
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
    expect(mocked.reconcileAllStoredModelSelectionsMock).toHaveBeenCalledWith({
      forceCatalogRefresh: true,
    });
  });

  it("logs model refresh failures without throwing", async () => {
    mocked.reconcileAllStoredModelSelectionsMock.mockRejectedValueOnce(new Error("model failed"));

    await expect(
      refreshSessionCacheAfterOpencodeReady("opencode_start_success"),
    ).resolves.toBeUndefined();

    expect(mocked.loggerWarnMock).toHaveBeenCalledWith(
      "[OpenCodeReady] Failed to refresh model catalog: reason=opencode_start_success",
      expect.any(Error),
    );
  });
  it("restores managed and secure MCP definitions whenever OpenCode becomes ready", async () => {
    mocked.restoreMcpRuntimeMock.mockResolvedValueOnce({ managed: { restored: 1, failed: 0 }, secure: { restored: 2, failed: 0 } });

    await refreshSessionCacheAfterOpencodeReady("auto_restart_startup");

    expect(mocked.restoreMcpRuntimeMock).toHaveBeenCalledTimes(1);
    expect(mocked.loggerDebugMock).toHaveBeenCalledWith(
      "[OpenCodeReady] MCP runtime restored: reason=auto_restart_startup, managed=1/0, secure=2/0",
    );
  });

  it("does not fail ready handling when MCP runtime restoration fails", async () => {
    mocked.restoreMcpRuntimeMock.mockRejectedValueOnce(new Error("credential restore failed"));

    await expect(
      refreshSessionCacheAfterOpencodeReady("auto_restart_interval"),
    ).resolves.toBeUndefined();

    expect(mocked.loggerWarnMock).toHaveBeenCalledWith(
      "[OpenCodeReady] Failed to restore MCP runtime: reason=auto_restart_interval",
      expect.any(Error),
    );
    expect(mocked.reconcileAllStoredModelSelectionsMock).toHaveBeenCalledWith({
      forceCatalogRefresh: true,
    });
  });


  it("waits for a restarted OpenCode server and then restores MCP runtime state", async () => {
    mocked.healthMock
      .mockResolvedValueOnce({ data: { healthy: false }, error: null })
      .mockResolvedValueOnce({ data: { healthy: true }, error: null });

    const refreshed = await waitForOpencodeReadyAndRefresh("provider_change", {
      timeoutMs: 50,
      pollIntervalMs: 1,
    });

    expect(refreshed).toBe(true);
    expect(mocked.healthMock).toHaveBeenCalledTimes(2);
    expect(mocked.restoreMcpRuntimeMock).toHaveBeenCalledTimes(1);
    expect(mocked.reconcileAllStoredModelSelectionsMock).toHaveBeenCalledWith({
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
    expect(mocked.restoreMcpRuntimeMock).not.toHaveBeenCalled();
  });

});
