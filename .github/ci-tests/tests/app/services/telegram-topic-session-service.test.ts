import { describe, expect, it } from "vitest";
import { getNextManagedChatTitle } from "../../../src/app/services/telegram-topic-session-service.js";
import type { TelegramTopicBinding } from "../../../src/app/services/telegram-topic-store.js";

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

  it("ignores Image Chat and bindings from other Telegram chats", () => {
    expect(getNextManagedChatTitle([
      binding(100, "🎨 Image Chat", 9),
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
