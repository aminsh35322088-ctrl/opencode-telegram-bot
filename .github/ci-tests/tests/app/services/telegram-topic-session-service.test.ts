import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { getNextManagedChatTitle, sendToTelegramTopic } from "../../../src/app/services/telegram-topic-session-service.js";
import type { TelegramTopicBinding } from "../../../src/app/services/telegram-topic-store.js";

const mocked = vi.hoisted(() => ({
  resolveCoreSessionRoute: vi.fn(),
  isCurrentCoreSessionRoute: vi.fn(),
}));

vi.mock("../../../src/core/native-core-service.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/core/native-core-service.js")>(),
  resolveCoreSessionRoute: mocked.resolveCoreSessionRoute,
  isCurrentCoreSessionRoute: mocked.isCurrentCoreSessionRoute,
}));

function binding(chatId: number, title: string, threadId: number): TelegramTopicBinding {
  return {
    chatId,
    threadId,
    sessionId: `session-${chatId}-${threadId}`,
    directory: `/tmp/topic-${chatId}-${threadId}`,
    title,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("Telegram managed Topic numbering", () => {
  it("reuses #01 when only a later managed Chat remains", () => {
    expect(getNextManagedChatTitle([
      binding(100, "Chat #05", 50),
    ], 100)).toBe("Chat #01");
  });

  it("fills the lowest gap instead of using max + 1", () => {
    expect(getNextManagedChatTitle([
      binding(100, "Chat #01", 10),
      binding(100, "Chat #02", 20),
      binding(100, "Chat #05", 50),
    ], 100)).toBe("Chat #03");
  });

  it("ignores non-managed titles and bindings from other Telegram chats", () => {
    expect(getNextManagedChatTitle([
      binding(100, "Manual Topic", 9),
      binding(100, "Chat #01", 10),
      binding(200, "Chat #02", 20),
    ], 100)).toBe("Chat #02");
  });

  it("continues after a dense prefix", () => {
    expect(getNextManagedChatTitle([
      binding(100, "Chat #01", 10),
      binding(100, "Chat #02", 20),
      binding(100, "Chat #03", 30),
    ], 100)).toBe("Chat #04");
  });
});

describe("Telegram Topic outbound routing", () => {
  const destination = binding(100, "Chat #01", 10);
  const route = {
    bindingId: "100:10",
    botId: "bot",
    chatId: 100,
    threadId: 10,
    sessionId: destination.sessionId,
    normalizedDirectory: path.resolve(destination.directory),
    bindingGeneration: 1,
  };

  beforeEach(() => {
    mocked.resolveCoreSessionRoute.mockReset().mockReturnValue(route);
    mocked.isCurrentCoreSessionRoute.mockReset().mockReturnValue(true);
  });

  it("sends only to the captured Topic route", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
    await sendToTelegramTopic({ sendMessage } as never, destination, "Ready", route);
    expect(sendMessage).toHaveBeenCalledWith(100, "Ready", { message_thread_id: 10 });
  });

  it("drops a late message when the captured Core generation retires", async () => {
    const sendMessage = vi.fn();
    mocked.isCurrentCoreSessionRoute.mockReturnValue(false);
    await expect(sendToTelegramTopic({ sendMessage } as never, destination, "Stale", route))
      .rejects.toThrow("Core Topic binding changed");
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
