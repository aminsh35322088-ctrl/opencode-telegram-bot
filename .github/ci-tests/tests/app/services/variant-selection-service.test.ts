import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  providersMock: vi.fn(),
  getCurrentModelMock: vi.fn(),
  setCurrentModelMock: vi.fn(),
  loggerDebugMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerInfoMock: vi.fn(),
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    config: {
      providers: mocked.providersMock,
    },
  },
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getCurrentModel: mocked.getCurrentModelMock,
  setCurrentModel: mocked.setCurrentModelMock,
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: {
    debug: mocked.loggerDebugMock,
    error: mocked.loggerErrorMock,
    warn: mocked.loggerWarnMock,
    info: mocked.loggerInfoMock,
  },
}));

import {
  getAvailableVariants,
  getCurrentVariant,
  getVariantAvailability,
  validateVariantForModel,
} from "../../../src/app/services/variant-selection-service.js";

function createProviderResponse(variants?: Record<string, unknown>) {
  return {
    data: {
      providers: [
        {
          id: "openai",
          name: "OpenAI",
          models: {
            "test-model": {
              name: "Test Model",
              ...(variants === undefined ? {} : { variants }),
            },
          },
        },
      ],
    },
    error: null,
  };
}

describe("variant manager", () => {
  beforeEach(() => {
    mocked.providersMock.mockReset();
    mocked.getCurrentModelMock.mockReset();
    mocked.setCurrentModelMock.mockReset();
    mocked.loggerDebugMock.mockReset();
    mocked.loggerErrorMock.mockReset();
    mocked.loggerWarnMock.mockReset();
    mocked.loggerInfoMock.mockReset();
  });

  it("reports unsupported when the model exposes no variants", async () => {
    mocked.providersMock.mockResolvedValue(createProviderResponse());

    await expect(getVariantAvailability("openai", "test-model")).resolves.toEqual({
      supported: false,
      reason: "UNSUPPORTED",
    });
    await expect(getAvailableVariants("openai", "test-model")).resolves.toEqual([]);
  });

  it("returns only variants exposed by OpenCode without injecting default", async () => {
    mocked.providersMock.mockResolvedValue(
      createProviderResponse({
        high: { reasoningEffort: "high" },
        fast: { disabled: true },
      }),
    );

    await expect(getAvailableVariants("openai", "test-model")).resolves.toEqual([
      { id: "high", disabled: false },
      { id: "fast", disabled: true },
    ]);
  });

  it("does not allow disabled variants to be selected", async () => {
    mocked.providersMock.mockResolvedValue(
      createProviderResponse({
        high: { disabled: false },
        fast: { disabled: true },
      }),
    );

    await expect(validateVariantForModel("openai", "test-model", "high")).resolves.toBe(true);
    await expect(validateVariantForModel("openai", "test-model", "fast")).resolves.toBe(false);
    await expect(validateVariantForModel("openai", "test-model", "missing")).resolves.toBe(false);
  });

  it("treats a provider API failure as unavailable rather than unsupported", async () => {
    mocked.providersMock.mockResolvedValue({ data: null, error: new Error("temporary failure") });

    await expect(getVariantAvailability("openai", "test-model")).resolves.toEqual({
      supported: false,
      reason: "UNAVAILABLE",
    });
  });

  it("does not throw when OpenCode provider discovery rejects", async () => {
    mocked.providersMock.mockRejectedValue(new Error("server unavailable"));

    await expect(getVariantAvailability("openai", "test-model")).resolves.toEqual({
      supported: false,
      reason: "UNAVAILABLE",
    });
  });

  it("keeps the internal default sentinel independent from model capability", () => {
    mocked.getCurrentModelMock.mockReturnValue({
      providerID: "openai",
      modelID: "test-model",
      variant: undefined,
    });

    expect(getCurrentVariant()).toBe("default");
  });
});
