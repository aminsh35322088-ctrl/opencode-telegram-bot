import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "@opencode-ai/sdk/v2";

const { globalEventMock } = vi.hoisted(() => ({ globalEventMock: vi.fn() }));

vi.mock("../../src/opencode/client.js", () => ({
  opencodeClient: { global: { event: globalEventMock }, session: { abort: vi.fn() } },
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
    globalEventMock.mockReset();
    bindings.bySession.mockReset().mockResolvedValue(null);
    bindings.byDirectory.mockReset().mockResolvedValue([]);
  });

  afterEach(() => stopTopicEventBus());

  it("delivers same-directory events only to the matching Topic session", async () => {
    const eventA = { type: "message.updated", properties: { sessionID: "session-a", directory: "/workspace" } } as unknown as Event;
    const eventB = { type: "message.updated", properties: { sessionID: "session-b", directory: "/workspace" } } as unknown as Event;

    globalEventMock.mockImplementationOnce(async (options: { signal: AbortSignal }) => ({ stream: createStream([eventA, eventB], options.signal) }));
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
    globalEventMock.mockImplementation(async (options: { signal: AbortSignal }) => ({
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
    await vi.waitFor(() => expect(globalEventMock).toHaveBeenCalledTimes(1));
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
    globalEventMock.mockImplementationOnce(async (options: { signal: AbortSignal }) => ({ stream: createStream([event], options.signal) }));

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
