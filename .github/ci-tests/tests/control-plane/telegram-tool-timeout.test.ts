import { describe, expect, it } from "vitest";
import { telegramAgentToolTimeoutMs } from "../../src/control-plane/application-transport.js";

describe("Topic media Control Plane request deadlines", () => {
  it("keeps bounded read-only Telegram actions short", () => {
    expect(telegramAgentToolTimeoutMs({ action: "context.current" })).toBe(30_000);
    expect(telegramAgentToolTimeoutMs({ action: "image.models" })).toBe(30_000);
    expect(telegramAgentToolTimeoutMs({ action: "media.chunk" })).toBe(30_000);
  });
  it("allows expensive media processing to finish before the Worker request deadline", () => {
    for (const action of ["image.generate", "image.edit", "stt.transcribe", "video.prepare"]) {
      expect(telegramAgentToolTimeoutMs({ action })).toBe(185_000);
    }
  });
});
