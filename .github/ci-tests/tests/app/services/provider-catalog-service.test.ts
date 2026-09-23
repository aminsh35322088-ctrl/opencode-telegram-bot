import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetProviderCatalogForTests, fetchProviderCatalog, peekProviderCatalog } from "../../../src/app/services/provider-catalog-service.js";
import { discoverModels } from "../../../src/app/services/custom-provider-service.js";
const url = "https://provider.example/v1";
const payload = { data: Array.from({ length: 200 }, (_, i) => ({ id: "model-" + i, pricing: { input: 0, output: 0 } })) };
beforeEach(() => { __resetProviderCatalogForTests(); });
describe("shared provider catalog", () => {
  it("shares one GET between discovery and 200 model price records", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(payload)));
    vi.stubGlobal("fetch", fetchMock);
    const [models, catalog] = await Promise.all([discoverModels(url, "key"), fetchProviderCatalog(url, "key")]);
    expect(models).toHaveLength(200);
    expect(catalog.records[0].pricing).toEqual({ input: 0, output: 0 });
    expect(models[0]).not.toHaveProperty("pricing");
    await fetchProviderCatalog(url, "key");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(url + "/models");
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty("method", "POST");
  });


  it("retries a timed-out model discovery request once", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new DOMException("The operation was aborted due to timeout", "TimeoutError"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "model-after-retry" }] })));
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await fetchProviderCatalog(url, "key");

    expect(catalog.records.map((record) => record.id)).toEqual(["model-after-retry"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("force refresh bypasses a fresh cached catalog", async () => {
    const first = { data: [{ id: "old-model" }] };
    const second = { data: [{ id: "old-model" }, { id: "new-model" }] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(first)))
      .mockResolvedValueOnce(new Response(JSON.stringify(second)));
    vi.stubGlobal("fetch", fetchMock);

    expect((await fetchProviderCatalog(url, "key")).records.map((record) => record.id)).toEqual(["old-model"]);
    expect((await fetchProviderCatalog(url, "key")).records.map((record) => record.id)).toEqual(["old-model"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const refreshed = await fetchProviderCatalog(url, "key", { force: true });
    expect(refreshed.records.map((record) => record.id)).toEqual(["old-model", "new-model"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("isolates changed credentials and URLs", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(payload)));
    vi.stubGlobal("fetch", fetchMock);
    await fetchProviderCatalog(url, "old-key");
    expect(peekProviderCatalog(url, "new-key")).toBeUndefined();
    await fetchProviderCatalog(url, "new-key");
    await fetchProviderCatalog(url + "/other", "new-key");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retains old evidence and backs off on refresh failures", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(payload))).mockResolvedValueOnce(new Response("error", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const old = await fetchProviderCatalog(url, "key");
    vi.advanceTimersByTime(300_001);
    await expect(fetchProviderCatalog(url, "key")).rejects.toThrow("503");
    expect(peekProviderCatalog(url, "key")).toBe(old);
    expect(await fetchProviderCatalog(url, "key")).toBe(old);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([{ data: [] }, { error: "bad response" }, { data: [null, {}, { id: 1 }] }])("rejects malformed catalogs %j", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
    await expect(fetchProviderCatalog(url, "key")).rejects.toThrow();
    expect(peekProviderCatalog(url, "key")).toBeUndefined();
  });
});
