import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "@opencode-ai/sdk/v2";

const { subscribeMock, bindings } = vi.hoisted(() => ({
  subscribeMock: vi.fn(),
  bindings: {
    byDirectory: vi.fn().mockResolvedValue(null),
    bySession: vi.fn().mockResolvedValue(null),
    byDirectoryList: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../../src/opencode/client.js", () => ({
  opencodeClient: {
    event: { subscribe: subscribeMock },
    session: { abort: vi.fn() },
  },
}));

vi.mock("../../src/app/services/telegram-topic-store.js", () => ({
  findTelegramTopicBindingByDirectory: bindings.byDirectory,
  findTelegramTopicBindingBySessionId: bindings.bySession,
  findTelegramTopicBindingsByDirectory: bindings.byDirectoryList,
}));

vi.mock("../../src/bot/services/agent-artifact-delivery-service.js", () => ({
  agentArtifactDeliveryService: { processEvent: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  __setSseIdleTimeoutForTests,
  stopEventListening,
  stopTopicEventSubscription,
  subscribeToEvents,
} from "../../src/opencode/events.js";
import { logger } from "../../src/utils/logger.js";
import { defined } from "../helpers/defined.js";

function createStream<T>(events: T[], signal: AbortSignal): AsyncGenerator<T, void, unknown> {
  return (async function* () {
    for (const event of events) {
      yield event;
    }

    while (!signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();
}

function createDeferredStream<T>(eventPromise: Promise<T>): AsyncGenerator<T, void, unknown> {
  return (async function* () {
    yield await eventPromise;
  })();
}

function createAbortableStream(signal: AbortSignal): AsyncGenerator<Event, void, unknown> {
  return (async function* () {
    while (!signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();
}

function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("opencode/events", () => {
  beforeEach(() => {
    subscribeMock.mockReset();
    bindings.byDirectory.mockReset().mockResolvedValue(null);
    bindings.bySession.mockReset().mockResolvedValue(null);
    bindings.byDirectoryList.mockReset().mockResolvedValue([]);
  });
  afterEach(() => {
    stopEventListening();
    __setSseIdleTimeoutForTests(30_000);
    vi.useRealTimers();
  });

  it("subscribes to the directory stream and forwards events to callback", async () => {
    const eventA = { type: "session.status", properties: { sessionID: "s1" } } as Event;
    const eventB = { type: "session.idle", properties: { sessionID: "s1" } } as Event;
    subscribeMock.mockImplementationOnce(async (params: { directory?: string; signal?: AbortSignal }) => ({
      stream: createStream([eventA, eventB], params?.signal ?? new AbortController().signal),
    }));

    const callback = vi.fn();
    const subscription = subscribeToEvents("D:/repo", callback);

    await vi.waitFor(() => {
      expect(callback).toHaveBeenCalledTimes(2);
    });
    await flushImmediate();

    stopEventListening();
    await subscription;

    expect(subscribeMock).toHaveBeenCalledWith(
      expect.objectContaining({ directory: "D:/repo", signal: expect.any(AbortSignal) }),
    );
    expect(callback).toHaveBeenCalledTimes(2);
    expect(defined(callback.mock.calls[0]?.[0])).toEqual(eventA);
    expect(defined(callback.mock.calls[1]?.[0])).toEqual(eventB);
  });

  it("logs callback errors without failing event delivery", async () => {
    const eventA = { type: "session.status", properties: { sessionID: "s1" } } as Event;
    const eventB = { type: "session.idle", properties: { sessionID: "s1" } } as Event;
    subscribeMock.mockImplementationOnce(async (params: { directory?: string; signal?: AbortSignal }) => ({
      stream: createStream([eventA, eventB], params?.signal ?? new AbortController().signal),
    }));
    const callbackError = new Error("callback failed");
    const loggerErrorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const callback = vi
      .fn()
      .mockImplementationOnce(() => {
        throw callbackError;
      })
      .mockImplementationOnce(() => undefined);

    const subscription = subscribeToEvents("D:/repo", callback);

    await vi.waitFor(() => {
      expect(callback).toHaveBeenCalledTimes(2);
    });
    await flushImmediate();

    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[TopicEventBus] Subscriber callback failed:"),
      callbackError,
    );

    stopEventListening();
    await subscription;
    loggerErrorSpy.mockRestore();
  });

  it("scopes an explicit sessionId subscription to that session's events", async () => {
    const eventA = { type: "session.idle", properties: { sessionID: "session-a", directory: "D:/repo" } } as unknown as Event;
    const eventB = { type: "session.idle", properties: { sessionID: "session-b", directory: "D:/repo" } } as unknown as Event;
    subscribeMock.mockImplementationOnce(async (params: { directory?: string; signal?: AbortSignal }) => ({
      stream: createStream([eventA, eventB], params?.signal ?? new AbortController().signal),
    }));

    const callback = vi.fn();
    const subscription = subscribeToEvents("D:/repo", callback, "session-a");

    await vi.waitFor(() => {
      expect(callback).toHaveBeenCalledWith(eventA);
    });
    await flushImmediate();

    stopEventListening();
    await subscription;

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("resolves the topic session from the directory binding when no sessionId is given", async () => {
    bindings.byDirectory.mockResolvedValue({ chatId: 1, threadId: 2, sessionId: "session-a", directory: "D:/repo" });
    const eventA = { type: "session.idle", properties: { sessionID: "session-a", directory: "D:/repo" } } as unknown as Event;
    const eventB = { type: "session.idle", properties: { sessionID: "session-b", directory: "D:/repo" } } as unknown as Event;
    subscribeMock.mockImplementationOnce(async (params: { directory?: string; signal?: AbortSignal }) => ({
      stream: createStream([eventA, eventB], params?.signal ?? new AbortController().signal),
    }));

    const callback = vi.fn();
    const subscription = subscribeToEvents("D:/repo", callback);

    await vi.waitFor(() => {
      expect(bindings.byDirectory).toHaveBeenCalledWith("D:/repo");
      expect(callback).toHaveBeenCalledWith(eventA);
    });
    await flushImmediate();

    stopEventListening();
    await subscription;

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("does not deliver queued callback after listener is stopped", async () => {
    const event = { type: "session.status", properties: { sessionID: "s1" } } as Event;
    let resolveEvent: (event: Event) => void = () => {};
    const eventPromise = new Promise<Event>((resolve) => {
      resolveEvent = resolve;
    });
    subscribeMock.mockResolvedValueOnce({ stream: createDeferredStream(eventPromise) });

    const callback = vi.fn();
    const subscription = subscribeToEvents("D:/repo", callback);

    await vi.waitFor(() => {
      expect(subscribeMock).toHaveBeenCalledTimes(1);
    });

    stopEventListening();
    resolveEvent(event);
    await flushImmediate();
    await subscription;

    expect(callback).not.toHaveBeenCalled();
  });

  it("stopTopicEventSubscription removes only the matching session subscription", async () => {
    subscribeMock.mockImplementation(async (params: { directory?: string; signal?: AbortSignal }) => ({
      stream: createAbortableStream(params?.signal ?? new AbortController().signal),
    }));

    const callbackA = vi.fn();
    const callbackB = vi.fn();
    await subscribeToEvents("D:/repo", callbackA, "session-a");
    await subscribeToEvents("D:/repo", callbackB, "session-b");
    await vi.waitFor(() => {
      expect(subscribeMock).toHaveBeenCalledTimes(1);
    });

    stopTopicEventSubscription("D:/repo", "session-a");

    stopEventListening();
    expect(callbackA).not.toHaveBeenCalled();
    expect(callbackB).not.toHaveBeenCalled();
  });

  it("reconnects when the stream ends unexpectedly", async () => {
    subscribeMock
      .mockImplementationOnce(async () => ({
        stream: (async function* () {
          // ends immediately
        })(),
      }))
      .mockImplementationOnce(async (params: { directory?: string; signal?: AbortSignal }) => ({
        stream: createAbortableStream(params?.signal ?? new AbortController().signal),
      }));

    const subscription = subscribeToEvents("D:/repo", vi.fn());

    await vi.waitFor(
      () => {
        expect(subscribeMock).toHaveBeenCalledTimes(2);
      },
      { timeout: 4000 },
    );

    stopEventListening();
    await subscription;
  });

  it("does not throw when subscribe result has no stream", async () => {
    subscribeMock.mockResolvedValue({ stream: null });
    const loggerWarnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    const subscription = await subscribeToEvents("D:/repo", vi.fn());

    expect(subscription).toBeUndefined();
    stopEventListening();
    await subscription;
    loggerWarnSpy.mockRestore();
  });
});
