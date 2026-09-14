import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { handleReactionFeedback } from "../../../src/app/services/reaction-feedback-service.js";
import { registerBotMessage, __resetBotMessageRegistryForTests } from "../../../src/app/managers/bot-message-registry.js";
import { assistantRunState } from "../../../src/app/managers/assistant-run-state-manager.js";
import { promptQueue } from "../../../src/app/managers/prompt-queue-manager.js";
import { opencodeClient } from "../../../src/opencode/client.js";
import { getCurrentSession } from "../../../src/app/services/session-service.js";
import { findTelegramTopicBindingBySessionId } from "../../../src/app/services/telegram-topic-store.js";

vi.mock("../../../src/app/services/session-service.js", () => ({
  getCurrentSession: vi.fn(() => null),
}));

vi.mock("../../../src/app/services/telegram-topic-store.js", () => ({
  findTelegramTopicBindingBySessionId: vi.fn(async () => null),
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    session: {
      promptAsync: vi.fn(async () => ({ error: null })),
      abort: vi.fn(async () => ({ error: null })),
    },
  },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function createReactionContext(chatId: number, messageId: number, emojis: string[], previousEmojis: string[] = []): Context {
  return {
    messageReaction: {
      chat: { id: chatId },
      message_id: messageId,
      old_reaction: previousEmojis.map((emoji) => ({ type: "emoji", emoji })),
      new_reaction: emojis.map((emoji) => ({ type: "emoji", emoji })),
    },
    api: {
      setMessageReaction: vi.fn(async () => {}),
    },
  } as unknown as Context;
}

describe("app/services/reaction-feedback-service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __resetBotMessageRegistryForTests();
    promptQueue.clearAll("test_setup");
    vi.mocked(getCurrentSession).mockReturnValue(null);
    vi.mocked(findTelegramTopicBindingBySessionId).mockResolvedValue(null);
    vi.mocked(opencodeClient.session.promptAsync).mockClear();
    vi.mocked(opencodeClient.session.abort).mockClear();
    vi.spyOn(assistantRunState, "hasActiveRun").mockReturnValue(false);
  });

  it("ignores reactions on messages that are not tracked bot messages", async () => {
    const ctx = createReactionContext(10, 999, ["👍"]);
    await handleReactionFeedback(ctx);
    expect(ctx.api.setMessageReaction).not.toHaveBeenCalled();
    expect(opencodeClient.session.promptAsync).not.toHaveBeenCalled();
  });

  it("acks approve reactions without touching the model", async () => {
    registerBotMessage({ chatId: 10, messageId: 100, sessionId: "session-1" });
    const ctx = createReactionContext(10, 100, ["👍"]);
    await handleReactionFeedback(ctx);
    expect(ctx.api.setMessageReaction).toHaveBeenCalledWith(10, 100, [{ type: "emoji", emoji: "🫡" }]);
    expect(opencodeClient.session.promptAsync).not.toHaveBeenCalled();
  });

  it("queues dissatisfied feedback while a run is active", async () => {
    registerBotMessage({ chatId: 10, messageId: 101, sessionId: "session-2" });
    vi.mocked(getCurrentSession).mockReturnValue({ id: "session-2", title: "t", directory: "/proj" });
    vi.spyOn(assistantRunState, "hasActiveRun").mockReturnValue(true);

    const ctx = createReactionContext(10, 101, ["👎"]);
    await handleReactionFeedback(ctx);

    const queued = promptQueue.list("session-2");
    expect(queued).toHaveLength(1);
    expect(queued[0]?.text).toContain("[Telegram feedback]");
    expect(opencodeClient.session.promptAsync).not.toHaveBeenCalled();
  });

  it("injects feedback via promptAsync when the session is idle", async () => {
    registerBotMessage({ chatId: 10, messageId: 102, sessionId: "session-3" });
    vi.mocked(getCurrentSession).mockReturnValue({ id: "session-3", title: "t", directory: "/proj" });

    const ctx = createReactionContext(10, 102, ["🤔"]);
    await handleReactionFeedback(ctx);

    expect(opencodeClient.session.promptAsync).toHaveBeenCalledTimes(1);
    const call = vi.mocked(opencodeClient.session.promptAsync).mock.calls[0]?.[0];
    expect(call?.sessionID).toBe("session-3");
    expect(call?.directory).toBe("/proj");
    expect(String((call?.parts as Array<{ text?: string }> | undefined)?.[0]?.text)).toContain("🤔");
  });

  it("aborts the session on strong negative reaction", async () => {
    registerBotMessage({ chatId: 10, messageId: 103, sessionId: "session-4" });
    vi.mocked(getCurrentSession).mockReturnValue({ id: "session-4", title: "t", directory: "/proj" });

    const ctx = createReactionContext(10, 103, ["🤬"]);
    await handleReactionFeedback(ctx);

    expect(opencodeClient.session.abort).toHaveBeenCalledWith({ sessionID: "session-4", directory: "/proj" });
    expect(opencodeClient.session.promptAsync).not.toHaveBeenCalled();
  });

  it("processes only newly added emojis and debounces duplicates", async () => {
    registerBotMessage({ chatId: 10, messageId: 104, sessionId: "session-5" });
    vi.mocked(getCurrentSession).mockReturnValue({ id: "session-5", title: "t", directory: "/proj" });

    const first = createReactionContext(10, 104, ["👍"]);
    await handleReactionFeedback(first);
    expect(first.api.setMessageReaction).toHaveBeenCalledTimes(1);

    const repeat = createReactionContext(10, 104, ["👍"]);
    await handleReactionFeedback(repeat);
    expect(repeat.api.setMessageReaction).not.toHaveBeenCalled();

    const removed = createReactionContext(10, 104, [], ["👍"]);
    await handleReactionFeedback(removed);
    expect(removed.api.setMessageReaction).not.toHaveBeenCalled();
  });
});
