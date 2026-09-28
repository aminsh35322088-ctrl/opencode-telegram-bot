import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "grammy";

const mocked = vi.hoisted(() => ({
  findBySession: vi.fn(),
  findByParent: vi.fn(),
  save: vi.fn(),
  update: vi.fn(),
  list: vi.fn(),
  messages: vi.fn(),
  isChatPaused: vi.fn(),
}));

vi.mock("../../../src/app/services/subagent-topic-store.js", () => ({
  findSubagentTopicBySession: mocked.findBySession,
  findSubagentTopicsByParent: mocked.findByParent,
  saveSubagentTopicBinding: mocked.save,
  updateSubagentTopicBinding: mocked.update,
  listSubagentTopicBindings: mocked.list,
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: { session: { messages: mocked.messages } },
}));

vi.mock("../../../src/app/managers/paused-session-manager.js", () => ({
  isChatPaused: mocked.isChatPaused,
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { subagentTopicInspector } from "../../../src/bot/services/subagent-topic-inspector.js";

function makeApi() {
  const raw = {
    createForumTopic: vi.fn(async () => ({ message_thread_id: 321 })),
    reopenForumTopic: vi.fn(async () => true),
    closeForumTopic: vi.fn(async () => true),
  };
  const sendMessage = vi.fn(async () => ({ message_id: 700 }));
  const editMessageText = vi.fn(async () => true);
  const deleteMessage = vi.fn(async () => true);
  return {
    api: { raw, sendMessage, editMessageText, deleteMessage } as unknown as Api,
    raw,
    sendMessage,
  };
}

describe("subagent topic inspector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.findBySession.mockResolvedValue(null);
    mocked.findByParent.mockResolvedValue([]);
    mocked.messages.mockResolvedValue({ data: [], error: null });
    mocked.isChatPaused.mockReturnValue(false);
  });

  it("creates no topic until open is explicitly requested, then persists one read-only viewer", async () => {
    const { api, raw, sendMessage } = makeApi();

    expect(raw.createForumTopic).not.toHaveBeenCalled();

    const result = await subagentTopicInspector.open(api, {
      chatId: 42,
      botId: 99,
      parentSessionId: "parent-1",
      sessionId: "child-1",
      directory: "/repo",
      title: "Explore repository",
    });

    expect(raw.createForumTopic).toHaveBeenCalledTimes(1);
    expect(mocked.save).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 42,
        threadId: 321,
        parentSessionId: "parent-1",
        sessionId: "child-1",
        closed: false,
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      42,
      expect.stringContaining("Read-only"),
      expect.objectContaining({
        message_thread_id: 321,
        reply_markup: expect.any(Object),
      }),
    );
    expect(result.binding.sessionId).toBe("child-1");

    const directButton = subagentTopicInspector.buildParentKeyboard([
      { sessionId: "child-1", agent: "explore", description: "Explore repository" },
    ])?.inline_keyboard[0]?.[0];
    expect(directButton).toEqual(
      expect.objectContaining({
        url: "tg://openmessage?user_id=99&message_id=321",
      }),
    );

    await subagentTopicInspector.close(api, result.binding, "user");
    const lazyButton = subagentTopicInspector.buildParentKeyboard([
      { sessionId: "child-1", agent: "explore", description: "Explore repository" },
    ])?.inline_keyboard[0]?.[0];
    expect(lazyButton).toEqual(
      expect.objectContaining({
        callback_data: "subagent:view:child-1",
      }),
    );
  });

  it("reopens and reuses the existing viewer instead of creating a duplicate topic", async () => {
    const existing = {
      chatId: 42,
      threadId: 222,
      parentSessionId: "parent-1",
      sessionId: "child-1",
      directory: "/repo",
      title: "Explore repository",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      closed: true,
      paused: false,
      messageIds: [],
    };
    mocked.findBySession.mockResolvedValue(existing);
    const { api, raw } = makeApi();

    const result = await subagentTopicInspector.open(api, {
      chatId: 42,
      botId: 99,
      parentSessionId: "parent-1",
      sessionId: "child-1",
      directory: "/repo",
      title: "Explore repository",
    });

    expect(raw.createForumTopic).not.toHaveBeenCalled();
    expect(raw.reopenForumTopic).toHaveBeenCalledWith({
      chat_id: 42,
      message_thread_id: 222,
    });
    expect(result.binding.threadId).toBe(222);
  });
});
