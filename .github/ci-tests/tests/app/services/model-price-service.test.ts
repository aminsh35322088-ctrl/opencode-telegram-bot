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


describe("official OpenCode Zen runtime prices", () => {
  const api = { id: "model", url: "https://opencode.ai/zen/v1", npm: "@ai-sdk/openai-compatible" };
  const zero = { input: 0, output: 0, cache: { read: 0, write: 0 } };
  function catalog(cost: unknown, url: string = api.url, id = "model-free") {
    fixture.native = { fetchedAt: Date.now(), models: [[id, { name: id, api: { ...api, url }, cost }]] };
  }
  it.each(["model-free", "big-pickle", "ordinary-name"])("shows official zero-cost %s as green without network requests", async (id) => {
    catalog(zero, api.url, id);
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    expect((await getProviderModelPrices("opencode")).get(id)?.group).toBe("free");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    [{ ...zero, cache: { read: 0.1, write: 0 } }, "paid"],
    [{ ...zero, input: 1 }, "paid"],
    [{ input: 0, cache: { read: 0, write: 0 } }, "hint"],
    [{ ...zero, cache: { read: "bad", write: 0 } }, "hint"],
    [{ ...zero, new_charge: 1 }, "hint"],
    [{ ...zero, experimentalOver200K: { input: 1, output: 2, cache: { read: 0, write: 0 } } }, "conditional"],
    [{ ...zero, experimentalOver200K: zero }, "free"],
    [{ ...zero, experimentalOver200K: { input: 0 } }, "hint"],
  ])("respects nested costs and incomplete evidence %j", async (cost, group) => {
    catalog(cost);
    expect((await getProviderModelPrices("opencode")).get("model-free")?.group).toBe(group);
  });
  it.each(["https://opencode.ai.example/zen/v1", "https://proxy.example/zen/v1", "http://opencode.ai/zen/v1", "https://opencode.ai/other/v1", "invalid"])("does not trust overridden endpoint %s", async (url) => {
    catalog(zero, url);
    expect((await getProviderModelPrices("opencode")).get("model-free")?.group).toBe("unknown");
  });
  it("keeps generic zero estimates conservative even when their endpoint is Zen", async () => {
    catalog(zero);
    expect((await getProviderModelPrices("other")).get("model-free")?.group).toBe("unknown");
  });
});
