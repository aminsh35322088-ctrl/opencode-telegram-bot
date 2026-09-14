import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "@opencode-ai/sdk/v2";
import { summaryAggregator } from "../../../src/app/managers/summary-aggregation-manager.js";
import { runInTopicRuntimeContext } from "../../../src/app/services/topic-runtime-context.js";
import { defined } from "../../helpers/defined.js";

const mocked = vi.hoisted(() => ({
  getCurrentProjectMock: vi.fn(),
}));

vi.mock("../../../src/app/stores/settings-store.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/app/stores/settings-store.js")>(
    "../../../src/app/stores/settings-store.js",
  );

  return {
    ...actual,
    getCurrentProject: mocked.getCurrentProjectMock,
  };
});

function assistantMessageEvent(sessionID: string, messageID: string, completed = false) {
  return {
    type: "message.updated",
    properties: {
      info: {
        id: messageID,
        sessionID,
        role: "assistant",
        time: completed
          ? { created: Date.now() - 1000, completed: Date.now() }
          : { created: Date.now() },
      },
    },
  } as unknown as Event;
}

function assistantTextPartEvent(sessionID: string, messageID: string, partID: string, text: string) {
  return {
    type: "message.part.updated",
    properties: {
      part: { id: partID, sessionID, messageID, type: "text", text },
    },
  } as unknown as Event;
}

describe("summary/aggregator concurrent AI topics", () => {
  beforeEach(() => {
    mocked.getCurrentProjectMock.mockReset();
    mocked.getCurrentProjectMock.mockReturnValue({ id: "p1", worktree: "D:/repo", name: "repo" });
    summaryAggregator.clear();
    summaryAggregator.setOnCleared(() => {});
    summaryAggregator.setOnTool(() => {});
    summaryAggregator.setOnRootToolUpdate(() => {});
    summaryAggregator.setOnToolFile(() => {});
    summaryAggregator.setOnPartial(() => {});
    summaryAggregator.setOnExternalUserInput(() => {});
    summaryAggregator.setOnThinking(() => {});
    summaryAggregator.setOnThinkingFinished(() => {});
    summaryAggregator.setOnSubagent(() => {});
    summaryAggregator.setOnSessionIdle(() => {});
    summaryAggregator.setOnSessionError(() => {});
    summaryAggregator.setOnSessionRetry(() => {});
  });

  it("keeps streaming an earlier topic's events after focus moved to another session", () => {
    const onPartial = vi.fn();
    const onComplete = vi.fn();
    summaryAggregator.setOnPartial(onPartial);
    summaryAggregator.setOnComplete(onComplete);

    summaryAggregator.setSession("session-a");
    summaryAggregator.processEvent(assistantMessageEvent("session-a", "msg-a1"));
    // Another topic attaches and takes the single focus.
    summaryAggregator.setSession("session-b");

    // session-a events keep arriving inside session-a's topic runtime
    // context (the topic event bus wraps every dispatch).
    runInTopicRuntimeContext({ chatId: 100, threadId: 11, sessionId: "session-a" }, () => {
      summaryAggregator.processEvent(assistantTextPartEvent("session-a", "msg-a1", "part-a1", "Hello from A"));
      summaryAggregator.processEvent(assistantMessageEvent("session-a", "msg-a1", true));
    });

    expect(onPartial).toHaveBeenCalledWith("session-a", "msg-a1", "Hello from A");
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0]?.[0]).toBe("session-a");
    expect(onComplete.mock.calls[0]?.[2]).toContain("Hello from A");
  });

  it("setSession on another topic does not wipe in-flight text state", () => {
    const onComplete = vi.fn();
    summaryAggregator.setOnComplete(onComplete);

    summaryAggregator.setSession("session-a");
    runInTopicRuntimeContext({ chatId: 100, threadId: 11, sessionId: "session-a" }, () => {
      summaryAggregator.processEvent(assistantMessageEvent("session-a", "msg-a2"));
      summaryAggregator.processEvent(assistantTextPartEvent("session-a", "msg-a2", "part-a2", "Partial answer in flight"));
    });

    // Main chat/other topic attaches elsewhere, then A's message completes.
    summaryAggregator.setSession("session-b");
    runInTopicRuntimeContext({ chatId: 100, threadId: 11, sessionId: "session-a" }, () => {
      summaryAggregator.processEvent(assistantMessageEvent("session-a", "msg-a2", true));
    });

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(defined(onComplete.mock.calls[0]?.[2])).toContain("Partial answer in flight");
  });
});
