import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The host bot spawns the OpenCode agent with Telegram credentials stripped
 * from the environment (src/opencode/process.ts buildAgentEnvironment).
 * Agent-side custom tools that load bot services (e.g. media image generation)
 * still need to import the config module to resolve non-secret settings.
 */
describe("config in an agent-like runtime", () => {
  const savedToken = process.env.TELEGRAM_BOT_TOKEN;
  const savedAllowedUserId = process.env.TELEGRAM_ALLOWED_USER_ID;

  beforeEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_ALLOWED_USER_ID;
    vi.resetModules();
  });

  afterEach(() => {
    if (savedToken !== undefined) {
      process.env.TELEGRAM_BOT_TOKEN = savedToken;
    } else {
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
    if (savedAllowedUserId !== undefined) {
      process.env.TELEGRAM_ALLOWED_USER_ID = savedAllowedUserId;
    } else {
      delete process.env.TELEGRAM_ALLOWED_USER_ID;
    }
  });

  it("loads without Telegram credentials and exposes non-secret config", async () => {
    const { config } = await import("../src/config.js");
    expect(config.bot.taskLimit).toBe(10);
    expect(config.opencode.model).toEqual({ provider: "opencode", modelId: "big-pickle" });
  });

  it("keeps credential access strict when telegram fields are actually read", async () => {
    const { config } = await import("../src/config.js");
    expect(() => config.telegram.token).toThrow(
      "Missing required environment variable: TELEGRAM_BOT_TOKEN",
    );
  });

  it("still resolves telegram config when the credentials are present", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-telegram-token";
    process.env.TELEGRAM_ALLOWED_USER_ID = "123456789";
    const { config } = await import("../src/config.js");
    expect(config.telegram.token).toBe("test-telegram-token");
    expect(config.telegram.allowedUserId).toBe(123456789);
  });
});