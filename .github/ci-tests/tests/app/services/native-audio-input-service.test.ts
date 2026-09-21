import { describe, expect, it } from "vitest";
import { prepareNativeAudioInput } from "../../../src/app/services/native-audio-input-service.js";

describe("native audio input preparation", () => {
  it("fails closed for unknown transport capability", async () => {
    await expect(prepareNativeAudioInput(Buffer.from("ogg"), "voice.ogg", "audio/ogg", {
      nativeAudioFileInput: "unknown",
      nativeAudioMimeTypes: [],
    })).resolves.toBeNull();
  });

  it("passes bytes through only when the verified transport accepts the exact MIME", async () => {
    const result = await prepareNativeAudioInput(Buffer.from("wav"), "voice.wav", "audio/wav", {
      nativeAudioFileInput: true,
      nativeAudioMimeTypes: ["audio/wav"],
    });
    expect(result).toEqual({ buffer: Buffer.from("wav"), filename: "voice.wav", mimeType: "audio/wav", transcoded: false });
  });

  it("never forwards an incompatible MIME when the transport has no safe normalization target", async () => {
    await expect(prepareNativeAudioInput(Buffer.from("ogg"), "voice.ogg", "audio/ogg", {
      nativeAudioFileInput: true,
      nativeAudioMimeTypes: ["audio/flac"],
    })).resolves.toBeNull();
  });
});