import { describe, expect, it } from "vitest";
import { getOpenCodeCustomModelConfig, normalizeDiscoveredModel } from "../../../src/app/services/custom-provider-service.js";

describe("custom-provider model capability normalization", () => {
  it("preserves standard modalities exposed by a provider", () => {
    const model = normalizeDiscoveredModel({
      id: "vision-model",
      name: "Vision Model",
      modalities: { input: ["text", "image"], output: ["text"] },
    });

    expect(model).toEqual({
      id: "vision-model",
      name: "Vision Model",
      attachment: true,
      modalities: { input: ["text", "image"], output: ["text"] },
    });
  });

  it("accepts OpenRouter-style architecture modality metadata", () => {
    const model = normalizeDiscoveredModel({
      id: "provider/model",
      architecture: {
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
      },
    });

    expect(model?.modalities).toEqual({ input: ["text", "image"], output: ["text"] });
    expect(model?.attachment).toBe(true);
  });

  it("preserves an explicit text-only declaration", () => {
    const model = normalizeDiscoveredModel({
      id: "text-model",
      modalities: { input: ["text"], output: ["text"] },
    });

    expect(getOpenCodeCustomModelConfig(model!)).toEqual({
      name: "text-model",
      attachment: false,
      modalities: { input: ["text"], output: ["text"] },
    });
  });

  it("uses a generic multimodal fallback when /models exposes no modality metadata", () => {
    const model = normalizeDiscoveredModel({ id: "unknown-model" });

    expect(model).toEqual({ id: "unknown-model", name: "unknown-model" });
    expect(getOpenCodeCustomModelConfig(model!)).toEqual({
      name: "unknown-model",
      attachment: true,
      modalities: { input: ["text", "image"], output: ["text"] },
    });
  });

  it("does not recognize unsupported arbitrary modality names", () => {
    const model = normalizeDiscoveredModel({
      id: "mixed-model",
      modalities: { input: ["text", "image", "unknown-type"], output: ["text"] },
    });

    expect(model?.modalities).toEqual({ input: ["text", "image"], output: ["text"] });
  });
});
