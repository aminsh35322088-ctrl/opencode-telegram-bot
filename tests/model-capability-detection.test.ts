import assert from "node:assert/strict";
import { test } from "node:test";
import { detectModelCapabilities, inferModelModalitiesFromIdentity } from "../src/app/services/model-capability-detection-service.js";
import { categorizeModelCatalog } from "../src/app/services/model-capability-categories-service.js";
import type { UnifiedModelCatalogEntry } from "../src/app/types/model-capability.js";

function entry(modelID: string, modelName: string, metadata: unknown): UnifiedModelCatalogEntry {
  const detected = detectModelCapabilities(metadata, { modelID, modelName });
  return {
    providerID: "provider",
    providerName: "Test Provider",
    modelID,
    modelName,
    capabilities: detected.capabilities,
    capabilityDetection: detected.detection,
    availability: "available",
  };
}

test("detects sparse /models records for media-only image, video, STT and TTS models", () => {
  const image = detectModelCapabilities({ id: "black-forest-labs/flux.1-schnell", name: "FLUX.1 Schnell" });
  assert.equal(image.capabilities.operations.imageGenerate, true);
  assert.equal(image.capabilities.operations.chat, false);
  assert.equal(image.capabilities.modalities.output.image, true);

  const video = detectModelCapabilities({ id: "google/veo-3.1", name: "Veo 3.1" });
  assert.equal(video.capabilities.operations.videoGenerate, true);
  assert.equal(video.capabilities.operations.chat, false);
  assert.equal(video.capabilities.modalities.output.video, true);

  const stt = detectModelCapabilities({ id: "whisper-large-v3", name: "Whisper Large V3" });
  assert.equal(stt.capabilities.operations.speechToText, true);
  assert.equal(stt.capabilities.operations.chat, false);
  assert.equal(stt.capabilities.modalities.input.audio, true);

  const tts = detectModelCapabilities({ id: "hexgrad/Kokoro-82M", name: "Kokoro TTS" });
  assert.equal(tts.capabilities.operations.textToSpeech, true);
  assert.equal(tts.capabilities.operations.chat, false);
  assert.equal(tts.capabilities.modalities.output.audio, true);
});

test("provider-advertised modalities take precedence over model-name heuristics", () => {
  const detected = detectModelCapabilities({
    id: "video-gen-model",
    name: "Video Generator",
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  });
  assert.equal(detected.capabilities.operations.videoGenerate, false);
  assert.equal(detected.capabilities.operations.chat, true);
  assert.equal(detected.detection.source, "provider-metadata");
});

test("sparse custom-provider discovery infers media modalities while retaining separate input and output", () => {
  assert.deepEqual(inferModelModalitiesFromIdentity("openai/whisper-large-v3"), { input: ["audio"], output: ["text"] });
  assert.deepEqual(inferModelModalitiesFromIdentity("stability-ai/stable-diffusion-xl"), { input: ["text"], output: ["image"] });
  assert.deepEqual(inferModelModalitiesFromIdentity("minimax/video-01"), { input: ["text"], output: ["video"] });
});

test("categorizes one provider catalog into Coding, Image, Voice-to-Text and Video AI", () => {
  const models = [
    entry("gpt-4.1", "GPT 4.1", { modalities: { input: ["text", "image"], output: ["text"] } }),
    entry("flux.1-schnell", "FLUX.1 Schnell", { id: "flux.1-schnell" }),
    entry("whisper-large-v3", "Whisper Large V3", { id: "whisper-large-v3" }),
    entry("veo-3.1", "Veo 3.1", { id: "veo-3.1" }),
    entry("gpt-image-1", "GPT Image 1", { modalities: { input: ["text", "image"], output: ["text", "image"] } }),
  ];
  const result = categorizeModelCatalog(models);
  assert.deepEqual(result.find((item) => item.category === "codingAI")?.models.map((item) => item.modelID).sort(), ["gpt-4.1", "gpt-image-1"]);
  assert.deepEqual(result.find((item) => item.category === "imageAI")?.models.map((item) => item.modelID).sort(), ["flux.1-schnell", "gpt-image-1"]);
  assert.deepEqual(result.find((item) => item.category === "voiceToText")?.models.map((item) => item.modelID), ["whisper-large-v3"]);
  assert.deepEqual(result.find((item) => item.category === "videoAI")?.models.map((item) => item.modelID), ["veo-3.1"]);
});
