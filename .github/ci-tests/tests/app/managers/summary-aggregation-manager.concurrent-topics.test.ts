import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "@opencode-ai/sdk/v2";
import { summaryAggregator } from "../../../src/app/managers/summary-aggregation-manager.js";
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

function assistantMessageEvent(sessionID: string, messageID: string, completed = false): Event {
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

function assistantTextPartEvent(sessionID: string, messageID: string, partID: string, text: string): Event {
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

  it("delivers each session's completion when focus moves between concurrent topics", () => {
    const onComplete = vi.fn();
    const onPartial = vi.fn();
    summaryAggregator.setOnComplete(onComplete);
    summaryAggregator.setOnPartial(onPartial);

    // session-a starts streaming an answer.
    summaryAggregator.setSession("session-a");
    summaryAggregator.processEvent(assistantMessageEvent("session-a", "msg-a"));
    summaryAggregator.processEvent(assistantTextPartEvent("session-a", "msg-a", "part-a", "Answer A"));

    // session-b takes the focus and finishes its own answer first.
    summaryAggregator.setSession("session-b");
    summaryAggregator.processEvent(assistantMessageEvent("session-b", "msg-b"));
    summaryAggregator.processEvent(assistantTextPartEvent("session-b", "msg-b", "part-b", "Answer B"));
    summaryAggregator.processEvent(assistantMessageEvent("session-b", "msg-b", true));

    // session-a reattaches and completes; its in-flight text must survive.
    summaryAggregator.setSession("session-a");
    summaryAggregator.processEvent(assistantMessageEvent("session-a", "msg-a", true));

    expect(onPartial).toHaveBeenCalledWith("session-a", "msg-a", "Answer A");
    expect(onPartial).toHaveBeenCalledWith("session-b", "msg-b", "Answer B");
    const completions = onComplete.mock.calls.map((call) => [call[0], call[1], call[2]]);
    expect(completions).toContainEqual(["session-a", "msg-a", "Answer A"]);
    expect(completions).toContainEqual(["session-b", "msg-b", "Answer B"]);
  });

  it("setSession on another topic does not wipe in-flight text state", () => {
    const onComplete = vi.fn();
    summaryAggregator.setOnComplete(onComplete);

    summaryAggregator.setSession("session-a");
    summaryAggregator.processEvent(assistantMessageEvent("session-a", "msg-a2"));
    summaryAggregator.processEvent(assistantTextPartEvent("session-a", "msg-a2", "part-a2", "Partial answer in flight"));

    // A different topic attaches (and completes its own message) while A is in flight.
    summaryAggregator.setSession("session-b");
    summaryAggregator.processEvent(assistantMessageEvent("session-b", "msg-b2"));
    summaryAggregator.processEvent(assistantTextPartEvent("session-b", "msg-b2", "part-b2", "Answer B"));
    summaryAggregator.processEvent(assistantMessageEvent("session-b", "msg-b2", true));

    // A completes; its earlier streamed text must not have been wiped.
    summaryAggregator.setSession("session-a");
    summaryAggregator.processEvent(assistantMessageEvent("session-a", "msg-a2", true));

    expect(onComplete).toHaveBeenCalledTimes(2);
    const aCompletion = onComplete.mock.calls.find((call) => call[0] === "session-a");
    expect(defined(aCompletion)).toBeDefined();
    expect(defined(aCompletion?.[2])).toContain("Partial answer in flight");
  });

  it("keeps three interleaved topics streaming independently while focus bounces", () => {
    const onComplete = vi.fn();
    const onPartial = vi.fn();
    summaryAggregator.setOnComplete(onComplete);
    summaryAggregator.setOnPartial(onPartial);

    // Three AI Topics stream at the same time; the event bus reattaches the
    // focus before dispatching each topic's next event.
    summaryAggregator.setSession("session-a");
    summaryAggregator.processEvent(assistantMessageEvent("session-a", "msg-1"));
    summaryAggregator.processEvent(assistantTextPartEvent("session-a", "msg-1", "part-1", "First topic answer"));

    summaryAggregator.setSession("session-b");
    summaryAggregator.processEvent(assistantMessageEvent("session-b", "msg-2"));
    summaryAggregator.processEvent(assistantTextPartEvent("session-b", "msg-2", "part-2", "Second topic answer"));

    summaryAggregator.setSession("session-c");
    summaryAggregator.processEvent(assistantMessageEvent("session-c", "msg-3"));
    summaryAggregator.processEvent(assistantTextPartEvent("session-c", "msg-3", "part-3", "Third topic answer"));

    // Completions land out of order (C, then A, then B); none may wipe or
    // hijack another topic's in-flight text.
    summaryAggregator.processEvent(assistantMessageEvent("session-c", "msg-3", true));
    summaryAggregator.setSession("session-a");
    summaryAggregator.processEvent(assistantMessageEvent("session-a", "msg-1", true));
    summaryAggregator.setSession("session-b");
    summaryAggregator.processEvent(assistantMessageEvent("session-b", "msg-2", true));

    expect(onPartial).toHaveBeenCalledWith("session-a", "msg-1", "First topic answer");
    expect(onPartial).toHaveBeenCalledWith("session-b", "msg-2", "Second topic answer");
    expect(onPartial).toHaveBeenCalledWith("session-c", "msg-3", "Third topic answer");

    expect(onComplete).toHaveBeenCalledTimes(3);
    const completions = onComplete.mock.calls.map((call) => [call[0], call[1], call[2]]);
    expect(completions).toContainEqual(["session-a", "msg-1", "First topic answer"]);
    expect(completions).toContainEqual(["session-b", "msg-2", "Second topic answer"]);
    expect(completions).toContainEqual(["session-c", "msg-3", "Third topic answer"]);
  });
});
