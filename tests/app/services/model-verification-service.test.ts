import { describe, expect, it, vi, afterEach } from "vitest";
import { analyzeModel, discoverProviderModels, isVerifiedFreeModel } from "../../../src/app/services/model-verification-service.js";

describe("model verification", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("treats zero pricing as verified free", () => {
    const result = analyzeModel({ id: "free-a", pricing: { prompt: "0", completion: "0" } });
    expect(result.status).toBe("free");
    expect(result.confidence).toBe("high");
    expect(result.source).toBe("pricing");
    expect(isVerifiedFreeModel(result)).toBe(true);
  });

  it("detects string is_free metadata", () => {
    const result = analyzeModel({ id: "provider-model", is_free: "true" });
    expect(result.status).toBe("free");
    expect(result.confidence).toBe("high");
    expect(result.source).toBe("explicit");
  });

  it("recognizes explicit :free variants", () => {
    const result = analyzeModel({ id: "qwen/qwen3-coder:free" });
    expect(result.status).toBe("free");
    expect(result.confidence).toBe("high");
    expect(result.source).toBe("id");
  });

  it("does not call a model paid when pricing is missing", () => {
    const result = analyzeModel({ id: "provider-model" });
    expect(result.status).toBe("unknown");
    expect(result.confidence).toBe("none");
    expect(result.source).toBe("none");
  });

  it("detects non-zero pricing as paid", () => {
    const result = analyzeModel({ id: "paid-model", pricing: { prompt: "0.000001", completion: "0.000002" } });
    expect(result.status).toBe("paid");
    expect(result.confidence).toBe("high");
    expect(result.source).toBe("pricing");
  });

  it("checks every pricing tier, not only the first tier", () => {
    const result = analyzeModel({
      id: "tiered-model",
      pricing: [
        { prompt: "0", completion: "0" },
        { prompt: "0.000001", completion: "0.000002" },
      ],
    });
    expect(result.status).toBe("paid");
    expect(result.source).toBe("pricing");
  });

  it("keeps conflicting metadata unknown", () => {
    const result = analyzeModel({ id: "conflict-model", free: true, pricing: { prompt: "0.001", completion: "0.002" } });
    expect(result.status).toBe("unknown");
    expect(result.confidence).toBe("medium");
    expect(result.source).toBe("explicit");
  });

  it("keeps non-free metadata plus zero pricing unknown", () => {
    const result = analyzeModel({ id: "conflict-model", is_free: false, pricing: { prompt: "0", completion: "0" } });
    expect(result.status).toBe("unknown");
    expect(result.confidence).toBe("medium");
    expect(result.source).toBe("explicit");
  });

  it("discovers the complete provider catalog and preserves free metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "paid", name: "Paid", pricing: { prompt: "0.001", completion: "0.002" } },
            { id: "free", name: "Free", pricing: { prompt: "0", completion: "0" } },
            { id: "unknown", name: "Unknown" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const models = await discoverProviderModels("https://example.test/v1", "secret");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/v1/models",
      expect.objectContaining({ headers: { Authorization: "Bearer secret" } }),
    );
    expect(models).toHaveLength(3);
    expect(models.find((model) => model.id === "free")).toMatchObject({ freeStatus: "free", freeConfidence: "high", freeSource: "pricing" });
    expect(models.find((model) => model.id === "unknown")).toMatchObject({ freeStatus: "unknown", freeConfidence: "none", freeSource: "none" });
  });

  it("prefers provider pricing over a low-confidence free-name hint", () => {
    const result = analyzeModel({ id: "free-looking-model", name: "free", pricing: { prompt: "0.001", completion: "0.001" } });
    expect(result.status).toBe("paid");
    expect(result.confidence).toBe("high");
    expect(result.source).toBe("pricing");
  });
});
