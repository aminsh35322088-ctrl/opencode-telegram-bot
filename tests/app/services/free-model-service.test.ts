import { afterEach, describe, expect, it, vi } from "vitest";

const providers = [
  { id: "provider-a", name: "Provider A", baseURL: "https://a.example", models: [], capability: "coding", createdAt: "", updatedAt: "" },
];

vi.mock("../../../src/app/services/custom-provider-service.js", () => ({
  getCustomProviderConfig: vi.fn(async () => ({ apiUrl: "https://a.example/v1", apiKey: "secret", models: [], capability: "coding" })),
  listCustomProviders: vi.fn(async () => providers),
}));

describe("free model service", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("scans the complete catalog and returns only high-confidence free models", async () => {
    const data = Array.from({ length: 200 }, (_, index) => ({
      id: `model-${index}`,
      name: `Model ${index}`,
      pricing: index === 17 || index === 153 ? { prompt: "0", completion: "0" } : { prompt: "0.001", completion: "0.002" },
    }));
    data.push({ id: "model-free-variant:free", name: "Free Variant" });
    data.push({ id: "model-free-hint", name: "Free", pricing: undefined });
    data.push({ id: "ambiguous", name: "Ambiguous", pricing: undefined });

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { __resetFreeModelScanCacheForTests, listVerifiedFreeModels } = await import("../../../src/app/services/free-model-service.js");
    __resetFreeModelScanCacheForTests();
    const result = await listVerifiedFreeModels({ force: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.map((model) => model.id)).toEqual(["model-153", "model-17", "model-free-variant:free"]);
    expect(result.every((model) => model.status === "free" && model.confidence === "high")).toBe(true);
  });

  it("keeps conflicting free metadata and paid pricing out of the verified-free set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [
        { id: "conflict", free: true, pricing: { prompt: "0.001", completion: "0.002" } },
        { id: "paid", pricing: { prompt: "0.001", completion: "0.002" } },
        { id: "free", free: true },
      ],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { __resetFreeModelScanCacheForTests, listVerifiedFreeModels } = await import("../../../src/app/services/free-model-service.js");
    __resetFreeModelScanCacheForTests();
    const result = await listVerifiedFreeModels({ force: true });

    expect(result.map((model) => model.id)).toEqual(["free"]);
  });
});
