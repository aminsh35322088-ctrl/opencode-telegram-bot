import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
  let customProviders: any[] = [];
  let runtimeProviders: any[] = [];

  return {
    customProviders: () => customProviders,
    runtimeProviders: () => runtimeProviders,
    setCustomProviders: (value: any[]) => { customProviders = value; },
    setRuntimeProviders: (value: any[]) => { runtimeProviders = value; },
    providers: vi.fn(async () => ({
      data: { providers: runtimeProviders },
      error: null,
    })),
    ensure: vi.fn(async (providerID: string, modelID: string) => {
      const provider = customProviders.find((item) => item.id === providerID);
      const model = provider?.models.find((item: any) => item.id === modelID);
      if (!model) return false;

      model.toolCall = true;
      model.toolCallVerified = true;
      runtimeProviders = [{
        id: providerID,
        name: provider.name,
        models: {
          [modelID]: {
            name: model.name,
            capabilities: {
              toolcall: true,
              output: { text: true },
            },
          },
        },
      }];
      return true;
    }),
  };
});

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    config: { providers: fixture.providers },
  },
}));

vi.mock("../../../src/app/services/custom-provider-service.js", () => ({
  ensureCustomProviderModelToolCapability: fixture.ensure,
  getCustomProvider: async (id: string) =>
    fixture.customProviders().find((provider) => provider.id === id),
  getGroqSttConfig: async () => undefined,
  listCustomProviders: async () => fixture.customProviders(),
  listCustomProvidersByCapability: async (capability: string) =>
    fixture.customProviders().filter(
      (provider) => provider.capability === capability,
    ),
}));

vi.mock("../../../src/app/services/image-ai-provider-service.js", () => ({
  listImageAiProviders: async () => [],
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  __resetUnifiedModelCatalogForTests,
  ensureUnifiedAgentModelReady,
  getUnifiedRuntimePriceMetadata,
  listUnifiedAgentModels,
  listUnifiedAgentProviders,
  listUnifiedAgentReadyModels,
  listUnifiedModelCatalog,
} from "../../../src/app/services/unified-model-catalog-service.js";

function runtimeModel(toolcall: boolean | undefined) {
  return {
    capabilities: {
      output: { text: true },
      ...(toolcall === undefined ? {} : { toolcall }),
    },
    cost: { input: 1, output: 2 },
  };
}

describe("unified model catalog", () => {
  beforeEach(() => {
    fixture.setCustomProviders([]);
    fixture.setRuntimeProviders([]);
    fixture.providers.mockClear();
    fixture.ensure.mockClear();
    __resetUnifiedModelCatalogForTests();
  });

  it("uses OpenCode runtime capabilities as final authority for native providers", async () => {
    fixture.setRuntimeProviders([{
      id: "native",
      name: "Native",
      models: {
        ready: runtimeModel(true),
        "no-tools": runtimeModel(false),
        unknown: runtimeModel(undefined),
      },
    }]);

    expect(await listUnifiedAgentModels("native")).toEqual([
      { providerID: "native", modelID: "ready" },
    ]);

    expect((await listUnifiedAgentProviders())[0]).toEqual({
      id: "native",
      name: "Native",
      modelCount: 1,
    });
  });

  it("keeps custom unverified models visible without treating them as ready", async () => {
    fixture.setCustomProviders([{
      id: "gateway",
      name: "Gateway",
      capability: "general",
      models: [{
        id: "coder",
        name: "Coder",
        modalities: { output: ["text"] },
        toolCall: true,
      }],
    }]);

    fixture.setRuntimeProviders([{
      id: "gateway",
      name: "Gateway",
      models: {
        coder: runtimeModel(false),
      },
    }]);

    expect(await listUnifiedAgentModels("gateway")).toEqual([
      { providerID: "gateway", modelID: "coder", name: "Coder" },
    ]);
    expect(await listUnifiedAgentReadyModels()).toEqual([]);

    const entry = (await listUnifiedModelCatalog()).find(
      (item) =>
        item.providerID === "gateway" &&
        item.modelID === "coder",
    );

    expect(entry?.origin).toBe("custom-provider");
    expect(entry?.agentReadiness?.state).toBe("unverified");
    expect((await listUnifiedAgentProviders())[0]).toMatchObject({
      id: "gateway",
      modelCount: 1,
      readyModelCount: 0,
      unverifiedModelCount: 1,
    });
  });

  it("hides custom models that were verified as tool-incompatible", async () => {
    fixture.setCustomProviders([{
      id: "gateway",
      name: "Gateway",
      capability: "general",
      models: [{
        id: "plain",
        name: "Plain",
        modalities: { output: ["text"] },
        toolCall: false,
        toolCallVerified: true,
      }],
    }]);

    expect(await listUnifiedAgentModels("gateway")).toEqual([]);

    const entry = (await listUnifiedModelCatalog()).find(
      (item) =>
        item.providerID === "gateway" &&
        item.modelID === "plain",
    );

    expect(entry?.agentReadiness?.state).toBe("unsupported");
  });

  it("verifies only the selected custom model and requires runtime confirmation", async () => {
    fixture.setCustomProviders([{
      id: "gateway",
      name: "Gateway",
      capability: "general",
      models: [
        {
          id: "coder",
          name: "Coder",
          modalities: { output: ["text"] },
        },
        {
          id: "other",
          name: "Other",
          modalities: { output: ["text"] },
        },
      ],
    }]);

    await expect(
      ensureUnifiedAgentModelReady("gateway", "coder"),
    ).resolves.toBe(true);

    expect(fixture.ensure).toHaveBeenCalledTimes(1);
    expect(fixture.ensure).toHaveBeenCalledWith(
      "gateway",
      "coder",
    );

    const ready = await listUnifiedAgentReadyModels();
    expect(
      ready.some(
        (entry) =>
          entry.providerID === "gateway" &&
          entry.modelID === "coder",
      ),
    ).toBe(true);
    expect(
      ready.some((entry) => entry.modelID === "other"),
    ).toBe(false);
  });

  it("keeps pricing metadata orthogonal to agent eligibility", async () => {
    fixture.setRuntimeProviders([{
      id: "priced",
      name: "Priced",
      models: {
        ready: runtimeModel(true),
        "price-only": runtimeModel(false),
      },
    }]);

    await listUnifiedModelCatalog();

    expect(
      getUnifiedRuntimePriceMetadata("priced")
        ?.models.map(([id]) => id)
        .sort(),
    ).toEqual(["price-only", "ready"]);

    expect(
      (await listUnifiedAgentModels("priced")).map(
        (model) => model.modelID,
      ),
    ).toEqual(["ready"]);
  });
});
