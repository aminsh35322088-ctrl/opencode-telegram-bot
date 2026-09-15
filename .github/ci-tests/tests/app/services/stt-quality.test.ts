import { describe, expect, it } from "vitest";
import { assessTranscription } from "../../../src/app/services/stt-quality.js";

const segment = (values: Record<string, unknown> = {}) => ({
  avg_logprob: -0.2,
  no_speech_prob: 0.01,
  compression_ratio: 1.5,
  ...values,
});

describe("assessTranscription", () => {
  const text = "این فایل رو با TypeScript اصلاح کن.";

  it("preserves mixed Persian/English speech and does not delete uncertain fragments", () => {
    expect(assessTranscription(text, [segment()])).toEqual({ text });
    expect(assessTranscription(text, [segment({ no_speech_prob: 0.9 })])).toEqual({ text });
    expect(assessTranscription(text, [segment(), segment({ avg_logprob: -1.4, no_speech_prob: 0.9 })])).toEqual({ text, uncertain: true });
    expect(assessTranscription(text, [segment({ avg_logprob: -1.4, no_speech_prob: 0.9 })])).toEqual({ text: "" });
    expect(assessTranscription(text, [segment({ compression_ratio: 3 })]).uncertain).toBe(true);
    expect(assessTranscription(text, [{ avg_logprob: null }]).uncertain).toBe(true);
    expect(assessTranscription(text, undefined).uncertain).toBe(true);
  });

  it("returns empty text for empty input", () => {
    expect(assessTranscription("   ", [segment()])).toEqual({ text: "" });
  });
});
