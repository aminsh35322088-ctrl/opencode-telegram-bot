import { beforeEach, describe, expect, it, vi } from "vitest";

async function loadConfig() {
  vi.resetModules();
  return (await import("../src/config.js")).config;
}

describe("current config", () => {
  beforeEach(() => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("TELEGRAM_ALLOWED_USER_ID", "123456789");
    vi.stubEnv("OPENCODE_MODEL_PROVIDER", "test-provider");
    vi.stubEnv("OPENCODE_MODEL_ID", "test-model");
    vi.stubEnv("OPENCODE_AUTO_RESTART_ENABLED", "");
    vi.stubEnv("OPENCODE_MONITOR_INTERVAL_SEC", "");
  });

  it("uses current defaults", async () => {
    const config = await loadConfig();
    expect(config.bot.trackBackgroundSessions).toBe(true);
    expect(config.bot.messageFormatMode).toBe("markdown");
    expect(config.bot.taskLimit).toBe(10);
    expect(config.opencode.autoRestartEnabled).toBe(false);
    expect(config.opencode.monitorIntervalSec).toBe(300);
  });

  it("parses current boolean and numeric settings", async () => {
    vi.stubEnv("TRACK_BACKGROUND_SESSIONS", "off");
    vi.stubEnv("OPENCODE_AUTO_RESTART_ENABLED", "true");
    vi.stubEnv("TASK_LIMIT", "25");
    vi.stubEnv("OPENCODE_MONITOR_INTERVAL_SEC", "600");
    const config = await loadConfig();
    expect(config.bot.trackBackgroundSessions).toBe(false);
    expect(config.opencode.autoRestartEnabled).toBe(true);
    expect(config.bot.taskLimit).toBe(25);
    expect(config.opencode.monitorIntervalSec).toBe(600);
  });

  it("parses the current initial settings preset", async () => {
    vi.stubEnv("INITIAL_SETTINGS_PRESET", '{"compactOutputMode":true,"showThinkingContent":false,"responseStreamingMode":"draft"}');
    const config = await loadConfig();
    expect(config.bot.initialSettingsPreset).toEqual({ compactOutputMode: true, showThinkingContent: false, responseStreamingMode: "draft" });
  });
});
