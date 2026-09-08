import { describe, expect, it } from "vitest";

import { config } from "../src/config.js";

describe("current config", () => {
  it("uses current hardcoded defaults", () => {
    expect(config.opencode.apiUrl).toBe("http://127.0.0.1:4096");
    expect(config.opencode.autoRestartEnabled).toBe(true);
    expect(config.opencode.monitorIntervalSec).toBe(60);
    expect(config.opencode.model).toEqual({ provider: "opencode", modelId: "big-pickle" });
    expect(config.bot.trackBackgroundSessions).toBe(true);
    expect(config.bot.messageFormatMode).toBe("markdown");
    expect(config.bot.taskLimit).toBe(10);
  });

  it("keeps telegram parsing strict about singular user ids", () => {
    expect(config.telegram.token).toBe("test-telegram-token");
    expect(config.telegram.allowedUserId).toBe(123456789);
  });

  it("exposes an empty initial settings preset", () => {
    expect(config.bot.initialSettingsPreset).toEqual({});
  });

  it("exposes helper sections with defaults", () => {
    expect(config.files.maxFileSizeKb).toBe(100);
    expect(config.stt.model).toBe("whisper-large-v3-turbo");
    expect(config.server.logLevel).toBe("info");
  });
});
