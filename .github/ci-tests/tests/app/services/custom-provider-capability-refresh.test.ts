import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  readAppState: vi.fn(),
  updateAppState: vi.fn(),
  globalDispose: vi.fn(),
  anyBusy: vi.fn(),
  reconcileBusy: vi.fn(),
  scheduledBusy: vi.fn(),
  opencodeActivity: vi.fn(),
}));

vi.mock("../../../src/app/stores/app-state-store.js", () => ({
  readAppState: mocks.readAppState,
  updateAppState: mocks.updateAppState,
}));
vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../../src/runtime/paths.js", () => ({
  getRuntimePaths: () => ({ appHome: os.tmpdir() }),
}));
vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: { global: { dispose: mocks.globalDispose } },
}));
vi.mock("../../../src/app/services/run-control-service.js", () => ({
  isAnyForegroundBusy: mocks.anyBusy,
  reconcileAllForegroundBusyState: mocks.reconcileBusy,
  getOpenCodeActivityState: mocks.opencodeActivity,
}));
vi.mock("../../../src/app/services/scheduled-task-runtime-service.js", () => ({
  scheduledTaskRuntime: { hasRunningTasks: mocks.scheduledBusy },
}));

import {
  refreshAndApplyCustomProviderToolCapabilities,
  refreshCustomProviderToolCapabilities,
} from "../../../src/app/services/custom-provider-service.js";

function providerStore() {
  return {
    providers: [{
      id: "race-provider",
      name: "Race Provider",
      baseURL: "https://provider.example/v1",
      apiKey: "sk-test",
      capability: "general" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      models: [{
        id: "agent-model",
        name: "Agent Model",
        toolCall: true,
        toolCallVerified: false,
        modalities: { input: ["text"], output: ["text"] },
      }],
    }],
  };
}

function toolCallResponse() {
  return new Response(JSON.stringify({
    choices: [{ message: { tool_calls: [{ function: { name: "opencode_action_probe" } }] } }],
  }), { status: 200 });
}

describe("custom-provider capability refresh", () => {
  let state: ReturnType<typeof providerStore>;

  beforeEach(() => {
    state = providerStore();
    mocks.readAppState.mockReset().mockImplementation(async () => ({ customProviders: state }));
    mocks.updateAppState.mockReset().mockImplementation(async (patch: unknown) => {
      const fn = patch as (current: { customProviders: typeof state }) => { customProviders?: typeof state };
      const result = fn({ customProviders: state });
      if (result.customProviders) state = result.customProviders;
    });
    mocks.globalDispose.mockReset().mockResolvedValue({ data: true, error: null });
    mocks.anyBusy.mockReset().mockReturnValue(false);
    mocks.reconcileBusy.mockReset().mockResolvedValue(undefined);
    mocks.scheduledBusy.mockReset().mockReturnValue(false);
    mocks.opencodeActivity.mockReset().mockResolvedValue("idle");
  });

  it("does not resurrect a provider deleted while its probe is in flight", async () => {
    let release!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    vi.stubGlobal("fetch", fetchMock);

    const refresh = refreshCustomProviderToolCapabilities();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    state = { providers: [] };
    release(toolCallResponse());

    await expect(refresh).resolves.toBe(false);
    expect(state.providers).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("persists verified capability and applies it to running OpenCode", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(toolCallResponse()));
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "capability-refresh-"));
    const configPath = path.join(dir, "custom-providers.json");

    await expect(refreshAndApplyCustomProviderToolCapabilities(configPath)).resolves.toBe(true);

    expect(state.providers[0]?.models[0]).toMatchObject({ toolCall: true, toolCallVerified: true });
    expect(await fs.readFile(configPath, "utf8")).toContain('"tool_call": true');
    expect(mocks.reconcileBusy).toHaveBeenCalledTimes(1);
    expect(mocks.globalDispose).toHaveBeenCalledTimes(1);

    await fs.rm(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("defers the runtime reload until active runs become idle", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(toolCallResponse()));
    mocks.anyBusy.mockReturnValue(true);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "capability-reload-"));
    const configPath = path.join(dir, "custom-providers.json");

    await expect(refreshAndApplyCustomProviderToolCapabilities(configPath)).resolves.toBe(true);
    expect(mocks.globalDispose).not.toHaveBeenCalled();

    mocks.anyBusy.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.globalDispose).toHaveBeenCalledTimes(1);

    await fs.rm(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("defers the runtime reload while a scheduled task is running", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(toolCallResponse()));
    mocks.scheduledBusy.mockReturnValue(true);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "capability-scheduled-"));
    const configPath = path.join(dir, "custom-providers.json");

    await expect(refreshAndApplyCustomProviderToolCapabilities(configPath)).resolves.toBe(true);
    expect(mocks.globalDispose).not.toHaveBeenCalled();

    mocks.scheduledBusy.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.globalDispose).toHaveBeenCalledTimes(1);

    await fs.rm(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("defers the runtime reload while OpenCode reports a background session busy", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(toolCallResponse()));
    mocks.opencodeActivity.mockResolvedValue("busy");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "capability-background-"));
    const configPath = path.join(dir, "custom-providers.json");

    await expect(refreshAndApplyCustomProviderToolCapabilities(configPath)).resolves.toBe(true);
    expect(mocks.globalDispose).not.toHaveBeenCalled();

    mocks.opencodeActivity.mockResolvedValue("idle");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.globalDispose).toHaveBeenCalledTimes(1);

    await fs.rm(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
});
