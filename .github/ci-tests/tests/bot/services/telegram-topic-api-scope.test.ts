import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/utils/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../../../src/i18n/index.js", () => ({ t: (key: string) => key, normalizeLocale: vi.fn(() => "en") }));

import { createTopicAwareApi, getUnscopedTelegramApi } from "../../../src/bot/services/telegram-topic-runtime.js";

type FakeSendApi = { sendMessage: ReturnType<typeof vi.fn>; editMessageText: ReturnType<typeof vi.fn> };

describe("bot/services/telegram-topic-runtime api scope", () => {
  it("injects the explicit Topic thread even without an active runtime context", async () => {
    const api: FakeSendApi = { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }), editMessageText: vi.fn() };
    const scoped = createTopicAwareApi(api as never, { chatId: 42, threadId: 7 });

    await scoped.sendMessage(42, "hello", { disable_notification: true });

    expect(api.sendMessage).toHaveBeenCalledWith(
      42,
      "hello",
      { disable_notification: true, message_thread_id: 7 },
    );
  });

  it("avoids cross-chat thread injection for a different chat id", async () => {
    const api: FakeSendApi = { sendMessage: vi.fn().mockResolvedValue({ message_id: 2 }), editMessageText: vi.fn() };
    const scoped = createTopicAwareApi(api as never, { chatId: 42, threadId: 7 });

    await scoped.sendMessage(99, "hello");

    expect(api.sendMessage).toHaveBeenCalledWith(99, "hello");
  });

  it("unwraps nested topic-aware proxies back to the raw api instance", () => {
    const api: FakeSendApi = { sendMessage: vi.fn(), editMessageText: vi.fn() };
    const one = createTopicAwareApi(api as never, { chatId: 42, threadId: 7 });
    const two = createTopicAwareApi(one, { chatId: 42, threadId: 7 });

    expect(getUnscopedTelegramApi(two)).toBe(api);
  });
});