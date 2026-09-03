import { describe, expect, it, vi } from "vitest";
import { deliverThinkingMessage } from "../../../src/bot/messages/thinking-message.js";
import { t } from "../../../src/i18n/index.js";

describe("bot/messages/thinking-message", () => {
  it("enqueues thinking once by prefix", () => {
    const batcher = {
      enqueueUniqueByPrefix: vi.fn(),
    };

    deliverThinkingMessage("s1", batcher);

    expect(batcher.enqueueUniqueByPrefix).toHaveBeenCalledWith("s1", t("bot.thinking"), "thinking_started");
  });
});
