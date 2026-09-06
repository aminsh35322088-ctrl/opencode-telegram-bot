import { describe, expect, it } from "vitest";

import { config } from "../src/config.js";

describe("config scheduled task notifications", () => {
  it("keeps scheduled task notifications enabled", () => {
    expect(config.bot.scheduledTaskNotificationsSilent).toBe(false);
  });

  it("keeps the scheduled task execution timeout bounded", () => {
    expect(config.bot.scheduledTaskExecutionTimeoutMinutes).toBe(120);
  });
});
