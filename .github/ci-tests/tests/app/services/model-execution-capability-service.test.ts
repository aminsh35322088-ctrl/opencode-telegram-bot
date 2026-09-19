import { describe, expect, it } from "vitest";
import { detectModelExecutionCapabilities, nativeAudioTransportAccepts } from "../../../src/app/services/model-execution-capability-service.js";

describe("model execution capability detection", () => {
  it("does not infer native audio transport from model audio modality or adapter package", () => {
    const result = detectModelExecutionCapabilities({
      api: { npm: "@ai-sdk/openai" },
      capabilities: { input: { audio: true } },
    });
    expect(result.execution.nativeAudioFileInput).toBe("unknown");
    expect(result.execution.nativeAudioMimeTypes).toEqual([]);
  });

  it("requires an explicit transport contract with MIME types", () => {
    const noMimes = detectModelExecutionCapabilities({ execution: { nativeAudioFileInput: true } });
    expect(noMimes.execution.nativeAudioFileInput).toBe("unknown");

    const verified = detectModelExecutionCapabilities({
      execution: { nativeAudioFileInput: true, nativeAudioMimeTypes: ["audio/wav", "audio/mpeg"] },
    });
    expect(verified.execution.nativeAudioFileInput).toBe(true);
    expect(nativeAudioTransportAccepts(verified.execution, "audio/wav")).toBe(true);
    expect(nativeAudioTransportAccepts(verified.execution, "audio/ogg")).toBe(false);
  });

  it("honors an explicit negative adapter contract", () => {
    const result = detectModelExecutionCapabilities({ transport: { nativeAudioFileInput: false } });
    expect(result.execution.nativeAudioFileInput).toBe(false);
    expect(result.detection.confidence).toBe("high");
  });
});