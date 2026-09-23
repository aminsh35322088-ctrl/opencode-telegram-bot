import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  __resetModelsDevPriceCatalogForTests,
  peekModelsDevProviderPrices,
  refreshModelsDevPriceCatalog,
} from "../../../src/app/services/models-dev-price-service.js";

function response(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Models.dev price evidence cache", () => {
  beforeEach(() => {
    __resetModelsDevPriceCatalogForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("uses only explicit Models.dev cost records and understands reasoning/context tiers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      demo: {
        id: "demo",
        models: {
          free: {
            id: "free",
            name: "Free",
            cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
          },
          reasoning_paid: {
            id: "reasoning_paid",
            name: "Reasoning Paid",
            cost: { input: 0, output: 0, reasoning: 1 },
          },
          conditional: {
            id: "conditional",
            name: "Conditional",
            cost: {
              input: 0,
              output: 0,
              tiers: [{
                input: 1,
                output: 2,
                tier: { type: "context", size: 200000 },
              }],
            },
          },
          missing: {
            id: "missing",
            name: "No published cost",
          },
        },
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await refreshModelsDevPriceCatalog({ force: true });
    const prices = peekModelsDevProviderPrices("demo")!;

    expect(prices.get("free")?.group).toBe("free");
    expect(prices.get("reasoning_paid")?.group).toBe("paid");
    expect(prices.get("conditional")?.group).toBe("conditional");
    expect(prices.has("missing")).toBe(false);
  });

  it("reuses the cached snapshot without repeating the multi-megabyte catalog request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      demo: {
        id: "demo",
        models: {
          free: { id: "free", name: "Free", cost: { input: 0, output: 0 } },
        },
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await refreshModelsDevPriceCatalog();
    await refreshModelsDevPriceCatalog();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(peekModelsDevProviderPrices("demo")?.get("free")?.group).toBe("free");
  });

  it("keeps the previous cached evidence when a background refresh fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        demo: {
          id: "demo",
          models: {
            free: { id: "free", name: "Free", cost: { input: 0, output: 0 } },
          },
        },
      }))
      .mockRejectedValueOnce(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    await refreshModelsDevPriceCatalog({ force: true });
    await refreshModelsDevPriceCatalog({ force: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(peekModelsDevProviderPrices("demo")?.get("free")?.group).toBe("free");
  });
});
