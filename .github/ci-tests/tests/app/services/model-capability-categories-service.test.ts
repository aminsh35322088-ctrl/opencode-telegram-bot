import { describe, expect, it } from "vitest";
import { categorizeModelCatalog } from "../../../src/app/services/model-capability-categories-service.js";
import { detectModelCapabilities } from "../../../src/app/services/model-capability-detection-service.js";
import type { UnifiedModelCatalogEntry } from "../../../src/app/types/model-capability.js";

function entry(modelID: string, modelName: string, metadata: unknown): UnifiedModelCatalogEntry {
  const detected = detectModelCapabilities(metadata, { modelID, modelName });
  return {
    providerID: "shared-api",
    providerName: "Shared API",
    modelID,
    modelName,
    capabilities: detected.capabilities,
    capabilityDetection: detected.detection,
    availability: "available",
  };
}

describe("auto-detected model capability groups", () => {
  it("separates coding, image, transcription and video models from one API while allowing multimodal overlap", () => {
    const summaries = categorizeModelCatalog([
      entry("coder", "Coder", { modalities: { input: ["text"], output: ["text"] } }),
      entry("flux.1-schnell", "FLUX.1 Schnell", { id: "flux.1-schnell" }),
      entry("whisper-large-v3", "Whisper Large V3", { id: "whisper-large-v3" }),
      entry("veo-3.1", "Veo 3.1", { id: "veo-3.1" }),
      entry("gpt-image-1", "GPT Image 1", { modalities: { input: ["text", "image"], output: ["text", "image"] } }),
    ]);
    const ids = (category: typeof summaries[number]["category"]) => summaries.find((summary) => summary.category === category)!.models.map((model) => model.modelID).sort();
    expect(ids("codingAI")).toEqual(["coder", "gpt-image-1"]);
    expect(ids("imageAI")).toEqual(["flux.1-schnell", "gpt-image-1"]);
    expect(ids("voiceToText")).toEqual(["whisper-large-v3"]);
    expect(ids("videoAI")).toEqual(["veo-3.1"]);
  });

  it("does not classify known image/video/voice generators as Coding AI only", () => {
    const summaries = categorizeModelCatalog([
      entry("flux.1-dev", "FLUX.1 dev", { id: "flux.1-dev" }),
      entry("minimax/video-01", "Video 01", { id: "minimax/video-01" }),
      entry("whisper-large-v3", "Whisper", { id: "whisper-large-v3" }),
      entry("kokoro-82m", "Kokoro TTS", { id: "kokoro-82m" }),
    ]);
    expect(summaries.find((item) => item.category === "codingAI")!.models).toHaveLength(0);
  });
});
