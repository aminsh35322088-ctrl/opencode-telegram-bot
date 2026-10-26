import { describe, expect, it } from "vitest";
import { detectModelCapabilities, inferModelModalitiesFromIdentity, parseModalityTransition } from "../../../src/app/services/model-capability-detection-service.js";

describe("model capability detection", () => {
  it("keeps absent metadata unknown instead of converting it to false", () => {
    const result = detectModelCapabilities({ id: "opaque-model" });
    expect(result.capabilities.modalities.input.image).toBe("unknown");
    expect(result.capabilities.operations.chat).toBe("unknown");
    expect(result.capabilities.operations.imageGenerate).toBe("unknown");
    expect(result.detection).toEqual({ source: "heuristic", confidence: "low" });
  });

  it("classifies one multimodal model into multiple capabilities", () => {
    const result = detectModelCapabilities({
      modalities: { input: ["text", "image", "audio"], output: ["text", "image"] },
      capabilities: { toolcall: true, reasoning: true },
    });
    expect(result.capabilities.operations.chat).toBe(true);
    expect(result.capabilities.operations.imageGenerate).toBe(true);
    expect(result.capabilities.operations.imageEdit).toBe(true);
    expect(result.capabilities.modalities.input.audio).toBe(true);
    expect(result.capabilities.agent.toolCalling).toBe(true);
  });

  it("does not infer speech-to-text from audio input plus text output alone", () => {
    const result = detectModelCapabilities({ modalities: { input: ["audio"], output: ["text"] } });
    expect(result.capabilities.operations.speechToText).toBe("unknown");
  });

  it("allows an adapter to authoritatively expose STT", () => {
    const result = detectModelCapabilities({ modalities: { input: ["audio"], output: ["text"] } }, { source: "adapter", confidence: "high", forceSpeechToText: true });
    expect(result.capabilities.operations.speechToText).toBe(true);
    expect(result.detection.source).toBe("adapter");
  });


  it("classifies sparse /models records using recognizable media model IDs", () => {
    const image = detectModelCapabilities({ id: "black-forest-labs/flux.1-schnell", name: "FLUX.1 Schnell" });
    expect(image.capabilities.operations.imageGenerate).toBe(true);
    expect(image.capabilities.operations.chat).toBe(false);

    const video = detectModelCapabilities({ id: "google/veo-3.1", name: "Veo 3.1" });
    expect(video.capabilities.operations.videoGenerate).toBe(true);
    expect(video.capabilities.operations.chat).toBe(false);

    const stt = detectModelCapabilities({ id: "whisper-large-v3", name: "Whisper Large V3" });
    expect(stt.capabilities.operations.speechToText).toBe(true);
    expect(stt.capabilities.operations.chat).toBe(false);

    const tts = detectModelCapabilities({ id: "hexgrad/Kokoro-82M", name: "Kokoro TTS" });
    expect(tts.capabilities.operations.textToSpeech).toBe(true);
    expect(tts.capabilities.operations.chat).toBe(false);
  });

  it("does not confuse an audio-chat model with a dedicated transcription model", () => {
    const result = detectModelCapabilities({ modalities: { input: ["audio"], output: ["text"] } });
    expect(result.capabilities.operations.speechToText).toBe("unknown");
  });

  it("supports directional modality strings from provider catalogs", () => {
    expect(parseModalityTransition("text -> text + image")).toEqual({ input: ["text"], output: ["text", "image"] });
    const result = detectModelCapabilities({ architecture: { modality: "text->video" } });
    expect(result.capabilities.operations.videoGenerate).toBe(true);
    expect(result.capabilities.operations.chat).toBe(false);
  });

  it("reads verified custom-provider camelCase tool metadata", () => {
    const result = detectModelCapabilities({
      modalities: { input: ["text"], output: ["text"] },
      toolCall: true,
    });
    expect(result.capabilities.agent.toolCalling).toBe(true);
  });

  it("reads OpenCode V2 capability arrays and tools flag", () => {
    const result = detectModelCapabilities({ capabilities: { tools: true, input: ["text", "image"], output: ["text"] } });
    expect(result.capabilities.modalities.input.image).toBe(true);
    expect(result.capabilities.modalities.output.text).toBe(true);
    expect(result.capabilities.agent.toolCalling).toBe(true);
  });
});