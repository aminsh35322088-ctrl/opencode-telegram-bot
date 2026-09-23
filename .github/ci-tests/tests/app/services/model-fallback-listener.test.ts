import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  configMock,
  providersMock,
  listCustomProvidersMock,
  getCurrentModelMock,
  setCurrentModelMock,
  setCurrentModelState,
  getCurrentModelState,
  resetCurrentModelState,
  loggerWarnMock,
} = vi.hoisted(() => {
  let currentModel: { providerID: string; modelID: string; variant?: string } | undefined;
  const getCurrentModelMock = vi.fn(() => currentModel);
  const setCurrentModelMock = vi.fn((modelInfo: { providerID: string; modelID: string; variant?: string }) => {
    currentModel = modelInfo;
  });
  return {
    configMock: {
      opencode: {
        model: { provider: "opencode", modelId: "big-pickle" },
      },
    },
    providersMock: vi.fn(),
    listCustomProvidersMock: vi.fn(),
    getCurrentModelMock,
    setCurrentModelMock,
    setCurrentModelState: (modelInfo?: { providerID: string; modelID: string; variant?: string }) => {
      currentModel = modelInfo;
    },
    getCurrentModelState: () => currentModel,
    resetCurrentModelState: () => {
      currentModel = undefined;
      getCurrentModelMock.mockClear();
      setCurrentModelMock.mockClear();
    },
    loggerWarnMock: vi.fn(),
  };
});

vi.mock("../../../src/config.js", () => ({ config: configMock }));
vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: { config: { providers: providersMock } },
}));
vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getCurrentModel: getCurrentModelMock,
  setCurrentModel: setCurrentModelMock,
}));
vi.mock("../../../src/utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: loggerWarnMock,
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock("../../../src/app/services/custom-provider-service.js", () => ({
  listCustomProviders: listCustomProvidersMock,
  listCustomProvidersByCapability: vi.fn().mockResolvedValue([]),
}));

import {
  __resetModelCatalogCacheForTests,
  reconcileStoredModelSelection,
  setModelFallbackListener,
} from "../../../src/app/services/model-selection-service.js";

function createProvidersResponse(modelsByProvider: Record<string, string[]>) {
  return {
    data: {
      providers: Object.entries(modelsByProvider).map(([providerID, modelIDs]) => ({
        id: providerID,
        models: Object.fromEntries(
          modelIDs.map((modelID) => [
            modelID,
            { id: modelID, capabilities: { toolcall: true, output: { text: true } } },
          ]),
        ),
      })),
    },
    error: null,
  };
}

describe("model-selection fallback listener", () => {
  beforeEach(() => {
    resetCurrentModelState();
    __resetModelCatalogCacheForTests();
    setModelFallbackListener(null);
    providersMock.mockReset();
    listCustomProvidersMock.mockReset();
    listCustomProvidersMock.mockResolvedValue([]);
    providersMock.mockResolvedValue(
      createProvidersResponse({
        opencode: ["big-pickle"],
        openai: ["gpt-4o"],
      }),
    );
  });

  afterEach(() => {
    setModelFallbackListener(null);
  });

  it("notifies the registered listener when the stored model falls back", async () => {
    const listener = vi.fn();
    setModelFallbackListener(listener);
    setCurrentModelState({ providerID: "openai", modelID: "retired", variant: "high" });

    await reconcileStoredModelSelection();

    expect(getCurrentModelState()).toEqual({
      providerID: "opencode",
      modelID: "big-pickle",
      variant: "default",
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      previous: "openai/retired",
      next: "opencode/big-pickle",
      reason: "unavailable_or_not_tool_capable",
    });
  });

  it("does not notify when the stored model remains valid", async () => {
    const listener = vi.fn();
    setModelFallbackListener(listener);
    setCurrentModelState({ providerID: "openai", modelID: "gpt-4o", variant: "high" });

    await reconcileStoredModelSelection();

    expect(listener).not.toHaveBeenCalled();
    expect(setCurrentModelMock).not.toHaveBeenCalled();
  });

  it("stops notifying after the listener is cleared", async () => {
    const listener = vi.fn();
    setModelFallbackListener(listener);
    setModelFallbackListener(null);
    setCurrentModelState({ providerID: "openai", modelID: "retired", variant: "high" });

    await reconcileStoredModelSelection();

    expect(listener).not.toHaveBeenCalled();
  });
});
