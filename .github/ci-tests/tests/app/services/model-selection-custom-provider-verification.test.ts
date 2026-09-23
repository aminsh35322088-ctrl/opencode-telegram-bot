import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let verified = false;
  let currentModel: { providerID: string; modelID: string; variant?: string } | undefined;
  return {
    verified: () => verified,
    resetVerified: () => { verified = false; },
    getCurrentModel: vi.fn(() => currentModel),
    setCurrentModel: vi.fn((value: { providerID: string; modelID: string; variant?: string }) => { currentModel = value; }),
    setCurrentModelState: (value?: { providerID: string; modelID: string; variant?: string }) => { currentModel = value; },
    ensure: vi.fn(async () => { verified = true; return true; }),
    providers: vi.fn(async () => [{
      id: "gateway",
      name: "Gateway",
      baseURL: "https://gateway.example/v1",
      capability: "general",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      models: [{
        id: "coder",
        name: "Coder",
        toolCall: true,
        ...(verified ? { toolCallVerified: true } : {}),
        modalities: { input: ["text"], output: ["text"] },
      }],
    }]),
    configProviders: vi.fn(),
  };
});

vi.mock("../../../src/config.js", () => ({
  config: { opencode: { model: { provider: "", modelId: "" } } },
}));
vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getCurrentModel: mocks.getCurrentModel,
  setCurrentModel: mocks.setCurrentModel,
}));
vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: { config: { providers: mocks.configProviders } },
}));
vi.mock("../../../src/app/services/custom-provider-service.js", () => ({
  ensureCustomProviderModelToolCapability: mocks.ensure,
  getCustomProvider: async (id: string) => (await mocks.providers()).find((provider) => provider.id === id),
  getGroqSttConfig: async () => undefined,
  listCustomProviders: mocks.providers,
  listCustomProvidersByCapability: mocks.providers,
}));
vi.mock("../../../src/app/services/image-ai-provider-service.js", () => ({
  listImageAiProviders: async () => [],
}));
vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  __resetModelCatalogCacheForTests,
  getProviderModels,
  isSelectableChatModel,
  reconcileStoredModelSelection,
} from "../../../src/app/services/model-selection-service.js";

describe("custom-provider model verification wiring", () => {
  beforeEach(() => {
    mocks.resetVerified();
    mocks.setCurrentModelState(undefined);
    mocks.getCurrentModel.mockClear();
    mocks.setCurrentModel.mockClear();
    mocks.ensure.mockClear();
    mocks.providers.mockClear();
    mocks.configProviders.mockReset().mockImplementation(async () => ({
      data: {
        providers: mocks.verified()
          ? [{
              id: "gateway",
              name: "Gateway",
              models: {
                coder: {
                  name: "Coder",
                  capabilities: { toolcall: true, output: { text: true } },
                },
              },
            }]
          : [],
      },
      error: null,
    }));
    __resetModelCatalogCacheForTests();
  });

  it("lists unverified custom models without probing them", async () => {
    await expect(getProviderModels("gateway")).resolves.toEqual([
      { providerID: "gateway", modelID: "coder", name: "Coder" },
    ]);
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it("selects a chat-capable custom model without gating on tool-call verification", async () => {
    await getProviderModels("gateway");
    expect(mocks.ensure).not.toHaveBeenCalled();

    await expect(isSelectableChatModel("gateway", "coder")).resolves.toBe(true);
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it("keeps a stored custom chat model without forcing tool-call verification", async () => {
    mocks.setCurrentModelState({ providerID: "gateway", modelID: "coder", variant: "high" });

    await reconcileStoredModelSelection({ forceCatalogRefresh: true });

    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(mocks.setCurrentModel).not.toHaveBeenCalled();
  });
});
