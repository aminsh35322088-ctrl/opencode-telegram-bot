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
  topicStates: vi.fn(),
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
vi.mock("../../../src/app/stores/topic-runtime-state-store.js", () => ({
  listTopicRuntimeStates: mocks.topicStates,
}));
vi.mock("../../../src/config.js", () => ({
  config: { opencode: { model: { provider: "", modelId: "" } } },
}));

import {
  refreshAndApplyCustomProviderToolCapabilities,
  refreshCustomProviderToolCapabilities,
  saveCustomProvider,
} from "../../../src/app/services/custom-provider-service.js";
import { __resetProviderCatalogForTests } from "../../../src/app/services/provider-catalog-service.js";

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
  let settings: Record<string, unknown>;

  beforeEach(() => {
    state = providerStore();
    settings = {};
    mocks.readAppState.mockReset().mockImplementation(async () => ({ customProviders: state, settings }));
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
    mocks.topicStates.mockReset().mockResolvedValue([]);
    __resetProviderCatalogForTests();
  });

  it("does not resurrect a provider deleted while its probe is in flight", async () => {
    let release!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    vi.stubGlobal("fetch", fetchMock);

    const refresh = refreshCustomProviderToolCapabilities([{ providerID: "race-provider", modelID: "agent-model" }]);
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

    await expect(
      refreshAndApplyCustomProviderToolCapabilities(configPath, [{ providerID: "race-provider", modelID: "agent-model" }]),
    ).resolves.toBe(true);

    expect(state.providers[0]?.models[0]).toMatchObject({ toolCall: true, toolCallVerified: true });
    expect(await fs.readFile(configPath, "utf8")).toContain('"tool_call": true');
    expect(mocks.reconcileBusy).toHaveBeenCalledTimes(2);
    expect(mocks.globalDispose).toHaveBeenCalledTimes(1);

    await fs.rm(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("rolls back a positive verification if the live OpenCode config cannot reload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(toolCallResponse()));
    mocks.globalDispose.mockResolvedValue({ data: null, error: new Error("reload failed") });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "capability-rollback-"));
    const configPath = path.join(dir, "custom-providers.json");

    await expect(
      refreshAndApplyCustomProviderToolCapabilities(configPath, [{ providerID: "race-provider", modelID: "agent-model" }]),
    ).resolves.toBe(false);

    expect(state.providers[0]?.models[0]).toMatchObject({ toolCall: true });
    expect(state.providers[0]?.models[0]?.toolCallVerified).toBeUndefined();
    expect(await fs.readFile(configPath, "utf8")).toContain('"tool_call": false');

    await fs.rm(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("persists a negative verification without reloading OpenCode", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "plain text" } }] }), { status: 200 }),
    ));
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "capability-negative-"));
    const configPath = path.join(dir, "custom-providers.json");

    await expect(
      refreshAndApplyCustomProviderToolCapabilities(configPath, [{ providerID: "race-provider", modelID: "agent-model" }]),
    ).resolves.toBe(true);

    expect(state.providers[0]?.models[0]).toMatchObject({ toolCall: false, toolCallVerified: true });
    expect(mocks.globalDispose).not.toHaveBeenCalled();

    await fs.rm(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("refuses capability mutation while a foreground run is active", async () => {
    const fetchMock = vi.fn().mockResolvedValue(toolCallResponse());
    vi.stubGlobal("fetch", fetchMock);
    mocks.anyBusy.mockReturnValue(true);

    await expect(
      refreshAndApplyCustomProviderToolCapabilities(undefined, [{ providerID: "race-provider", modelID: "agent-model" }]),
    ).resolves.toBe(false);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.globalDispose).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("refuses capability mutation while a scheduled task is active", async () => {
    const fetchMock = vi.fn().mockResolvedValue(toolCallResponse());
    vi.stubGlobal("fetch", fetchMock);
    mocks.scheduledBusy.mockReturnValue(true);

    await expect(
      refreshAndApplyCustomProviderToolCapabilities(undefined, [{ providerID: "race-provider", modelID: "agent-model" }]),
    ).resolves.toBe(false);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.globalDispose).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("refuses capability mutation while OpenCode reports a background session busy", async () => {
    const fetchMock = vi.fn().mockResolvedValue(toolCallResponse());
    vi.stubGlobal("fetch", fetchMock);
    mocks.opencodeActivity.mockResolvedValue("busy");

    await expect(
      refreshAndApplyCustomProviderToolCapabilities(undefined, [{ providerID: "race-provider", modelID: "agent-model" }]),
    ).resolves.toBe(false);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.globalDispose).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("does not probe an inactive large custom-provider catalog", async () => {
    state = {
      providers: [{
        ...providerStore().providers[0],
        models: Array.from({ length: 250 }, (_, index) => ({
          id: "model-" + index,
          name: "Model " + index,
          toolCall: true,
          toolCallVerified: false,
          modalities: { input: ["text"], output: ["text"] },
        })),
      }],
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshCustomProviderToolCapabilities()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("probes only the active model from a large legacy catalog", async () => {
    state = {
      providers: [{
        ...providerStore().providers[0],
        models: Array.from({ length: 250 }, (_, index) => ({
          id: "model-" + index,
          name: "Model " + index,
          toolCall: true,
          toolCallVerified: false,
          modalities: { input: ["text"], output: ["text"] },
        })),
      }],
    };
    settings = { currentModel: { providerID: "race-provider", modelID: "model-149" } };
    const fetchMock = vi.fn().mockResolvedValue(toolCallResponse());
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshCustomProviderToolCapabilities()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.providers[0]?.models.filter((model) => model.toolCallVerified === true)).toHaveLength(1);
    expect(state.providers[0]?.models[149]).toMatchObject({ id: "model-149", toolCallVerified: true, toolCall: true });
    vi.unstubAllGlobals();
  });

  it("saves a large OpenAI-compatible catalog with one /models request and zero tool probes", async () => {
    state = { providers: [] };
    const models = Array.from({ length: 200 }, (_, index) => ({
      id: "vendor/model-" + index,
      name: "Model " + index,
      modalities: { input: ["text"], output: ["text"] },
    }));
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: models }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(saveCustomProvider({
      name: "Large Gateway",
      baseURL: "https://gateway.example/v1",
      apiKey: "sk-test",
      models,
      capability: "general",
    })).resolves.toMatchObject({ id: "large-gateway" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://gateway.example/v1/models");
    expect(state.providers[0]?.models).toHaveLength(200);
    expect(state.providers[0]?.models.some((model) => model.toolCallVerified === true)).toBe(false);
    vi.unstubAllGlobals();
  });

});
