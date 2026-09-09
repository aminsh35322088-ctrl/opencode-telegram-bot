import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "@opencode-ai/sdk/v2";

const { subscribeMock } = vi.hoisted(() => ({ subscribeMock: vi.fn() }));

vi.mock("../../src/opencode/client.js", () => ({
  opencodeClient: { event: { subscribe: subscribeMock }, session: { abort: vi.fn() } },
}));

const bindings = vi.hoisted(() => ({
  bySession: vi.fn().mockResolvedValue(null),
  byDirectory: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/app/services/telegram-topic-store.js", () => ({
  findTelegramTopicBindingBySessionId: bindings.bySession,
  findTelegramTopicBindingsByDirectory: bindings.byDirectory,
}));

vi.mock("../../src/bot/services/agent-artifact-delivery-service.js", () => ({
  agentArtifactDeliveryService: { processEvent: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/opencode/provider-error-policy.js", () => ({
  isDeterministicProviderRetryError: vi.fn().mockReturnValue(false),
}));

import { stopTopicEventBus, stopTopicEventSubscription, subscribeToTopicEvents } from "../../src/opencode/topic-event-bus.js";

function createStream<T>(events: T[], signal: AbortSignal): AsyncGenerator<T, void, unknown> {
  return (async function* () {
    for (const event of events) yield event;
    while (!signal.aborted) await new Promise((resolve) => setTimeout(resolve, 5));
  })();
}

describe("topic-event-bus session isolation", () => {
  beforeEach(() => {
    subscribeMock.mockReset();
    bindings.bySession.mockReset().mockResolvedValue(null);
    bindings.byDirectory.mockReset().mockResolvedValue([]);
  });

  afterEach(() => stopTopicEventBus());

  it("delivers same-directory events only to the matching Topic session", async () => {
    const eventA = { type: "message.updated", properties: { sessionID: "session-a", directory: "/workspace" } } as unknown as Event;
    const eventB = { type: "message.updated", properties: { sessionID: "session-b", directory: "/workspace" } } as unknown as Event;

    subscribeMock.mockImplementationOnce(async (options: { signal: AbortSignal }) => ({ stream: createStream([eventA, eventB], options.signal) }));
    bindings.bySession.mockImplementation((sessionId: string) => Promise.resolve(
      sessionId === "session-a"
        ? { chatId: 100, threadId: 101, sessionId: "session-a", directory: "/workspace" }
        : sessionId === "session-b"
          ? { chatId: 100, threadId: 202, sessionId: "session-b", directory: "/workspace" }
          : null,
    ));

    const callbackA = vi.fn();
    const callbackB = vi.fn();
    subscribeToTopicEvents("/workspace", callbackA, "session-a");
    subscribeToTopicEvents("/workspace", callbackB, "session-b");

    await vi.waitFor(() => {
      expect(callbackA).toHaveBeenCalledWith(eventA);
      expect(callbackB).toHaveBeenCalledWith(eventB);
    });
    expect(callbackA).not.toHaveBeenCalledWith(eventB);
    expect(callbackB).not.toHaveBeenCalledWith(eventA);
  });

  it("can unsubscribe one Topic without removing another Topic on the same directory", async () => {
    let release = false;
    const eventB = { type: "message.updated", properties: { sessionID: "session-b", directory: "/workspace" } } as unknown as Event;
    subscribeMock.mockImplementation(async (options: { signal: AbortSignal }) => ({
      stream: (async function* () {
        while (!release && !options.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 5));
        if (options.signal.aborted) return;
        yield eventB;
        while (!options.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 5));
      })(),
    }));
    bindings.bySession.mockImplementation((sessionId: string) => Promise.resolve(sessionId === "session-b" ? { chatId: 100, threadId: 202, sessionId: "session-b", directory: "/workspace" } : null));

    const callbackA = vi.fn();
    const callbackB = vi.fn();
    subscribeToTopicEvents("/workspace", callbackA, "session-a");
    subscribeToTopicEvents("/workspace", callbackB, "session-b");
    await vi.waitFor(() => expect(subscribeMock).toHaveBeenCalledTimes(1));
    stopTopicEventSubscription("/workspace", "session-a");
    release = true;
    await vi.waitFor(() => expect(callbackB).toHaveBeenCalledWith(eventB));
    expect(callbackA).not.toHaveBeenCalled();
  });

  it("does not guess a Topic when multiple bindings share a directory and the event has no session id", async () => {
    const event = { type: "workspace.updated", properties: { directory: "/workspace" } } as unknown as Event;
    bindings.byDirectory.mockResolvedValue([
      { chatId: 100, threadId: 101, sessionId: "session-a", directory: "/workspace" },
      { chatId: 100, threadId: 202, sessionId: "session-b", directory: "/workspace" },
    ]);
    subscribeMock.mockImplementationOnce(async (options: { signal: AbortSignal }) => ({ stream: createStream([event], options.signal) }));

    const callbackA = vi.fn();
    const callbackB = vi.fn();
    subscribeToTopicEvents("/workspace", callbackA, "session-a");
    subscribeToTopicEvents("/workspace", callbackB, "session-b");

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(callbackA).not.toHaveBeenCalled();
    expect(callbackB).not.toHaveBeenCalled();
    expect(bindings.byDirectory).toHaveBeenCalledWith("/workspace");
  });
});


describe("overlapping Topic execution", () => {
  afterEach(() => stopTopicEventBus());

  it("does not rebind an old session event to the only remaining directory binding", async () => {
    bindings.bySession.mockResolvedValue(null);
    bindings.byDirectory.mockResolvedValue([{ chatId: 100, threadId: 11, sessionId: "new", directory: "/workspace" }]);
    const event = { type: "message.updated", properties: { sessionID: "old" } } as unknown as Event;
    const { logger } = await import("../../src/utils/logger.js");
    subscribeMock.mockImplementation(async (options: { signal: AbortSignal }) => ({ stream: (async function* () {
      yield event;

      while (!options.signal.aborted) await new Promise(resolve => setTimeout(resolve, 5));
    })() }));
    const callback = vi.fn();
    subscribeToTopicEvents("/workspace", callback, "new");
    await vi.waitFor(() => expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("event=stale_session_route_blocked")));
    expect(callback).not.toHaveBeenCalled();
  });

  it("keeps B progressing and preserves per-session order while A is suspended", async () => {
    const context = await import("../../src/app/services/topic-runtime-context.js");
    bindings.bySession.mockImplementation(async (id: string) => ({ chatId: 100, threadId: id === "a" ? 11 : 22, sessionId: id, directory: "/workspace" }));
    const events = ["a", "b", "a", "b"].map((id, index) => ({ type: "message.updated", properties: { sessionID: id, index } } as unknown as Event));
    subscribeMock.mockImplementation(async (options: { signal: AbortSignal }) => ({ stream: createStream(events, options.signal) }));
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const seenA: number[] = [];
    const seenB: number[] = [];
    subscribeToTopicEvents("/workspace", async event => {
      const index = (event.properties as unknown as { index: number }).index;
      if (index === 0) await blocked;
      expect(context.getTopicRuntimeContext()?.sessionId).toBe("a");
      seenA.push(index);
    }, "a");
    subscribeToTopicEvents("/workspace", async event => {
      expect(context.getTopicRuntimeContext()?.sessionId).toBe("b");
      seenB.push((event.properties as unknown as { index: number }).index);
    }, "b");
    try {
      await vi.waitFor(() => expect(seenB).toEqual([1, 3]));
      expect(seenA).toEqual([]);
    } finally { release(); }
    await vi.waitFor(() => expect(seenA).toEqual([0, 2]));
  });
});
