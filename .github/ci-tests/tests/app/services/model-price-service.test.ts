import { beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ config: undefined as any, native: undefined as any }));
vi.mock("../../../src/app/services/custom-provider-service.js", async (original) => ({
  ...await original<typeof import("../../../src/app/services/custom-provider-service.js")>(),
  getCustomProviderConfig: async () => fixture.config,
}));
vi.mock("../../../src/app/services/model-selection-service.js", async (original) => ({
  ...await original<typeof import("../../../src/app/services/model-selection-service.js")>(),
  getCachedProviderPriceMetadata: () => fixture.native,
}));
import { fetchProviderCatalog, __resetProviderCatalogForTests } from "../../../src/app/services/provider-catalog-service.js";
import { getProviderModelPrices } from "../../../src/app/services/model-price-service.js";
beforeEach(() => { fixture.config = undefined; fixture.native = undefined; __resetProviderCatalogForTests(); });
describe("price evidence source", () => {
  it("uses shared provider records without further network calls; detects duplicate conflicts", async () => {
    fixture.config = { apiUrl: "https://openrouter.ai/api/v1", apiKey: "key" };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [
      { id: "model:free" }, { id: "duplicate", free: true }, { id: "duplicate", free: false },
    ] })));
    vi.stubGlobal("fetch", fetchMock);
    await fetchProviderCatalog(fixture.config.apiUrl, "key");
    const prices = await getProviderModelPrices("p");
    expect(prices.get("model:free")?.group).toBe("free");
    expect(prices.get("duplicate")?.group).toBe("conflict");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fixture.config.apiKey = "changed";
    expect((await getProviderModelPrices("p")).size).toBe(0);
  });
  it("does not trust a lookalike hostname or stale evidence", async () => {
    fixture.config = { apiUrl: "https://openrouter.ai.example/v1", apiKey: "key" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "model:free" }] }))));
    await fetchProviderCatalog(fixture.config.apiUrl, "key");
    expect((await getProviderModelPrices("p")).get("model:free")?.group).toBe("hint");
    vi.useFakeTimers(); vi.advanceTimersByTime(900_001);
    expect((await getProviderModelPrices("p")).size).toBe(0);
  });
  it("never interprets OpenCode default zero costs as verified free", async () => {
    fixture.native = { fetchedAt: Date.now(), models: [["zero", { cost: { input: 0, output: 0 } }], ["paid", { cost: { input: 1, output: 2 } }]] };
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const prices = await getProviderModelPrices("native");
    expect(prices.get("zero")?.group).toBe("unknown");
    expect(prices.get("paid")?.group).toBe("paid");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
