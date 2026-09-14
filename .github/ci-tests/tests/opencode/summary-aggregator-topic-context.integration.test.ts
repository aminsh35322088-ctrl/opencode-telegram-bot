import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "@opencode-ai/sdk/v2";

const mocked = vi.hoisted(() => ({
  subscribe: vi.fn(),
  bySession: vi.fn(),
  byDirectory: vi.fn(),
}));

vi.mock("../../src/opencode/client.js", () => ({
  opencodeClient: {
    event: { subscribe: mocked.subscribe },
    session: { abort: vi.fn() },
  },
}));

vi.mock("../../src/app/services/telegram-topic-store.js", () => ({
  findTelegramTopicBindingBySessionId: mocked.bySession,
  findTelegramTopicBindingsByDirectory: mocked.byDirectory,
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

import { summaryAggregator } from "../../src/app/managers/summary-aggregation-manager.js";
import { stopTopicEventBus, subscribeToTopicEvents } from "../../src/opencode/topic-event-bus.js";

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

describe("topic event bus -> summary aggregator runtime-context integration", () => {
  beforeEach(() => {
    mocked.subscribe.mockReset();
    mocked.bySession.mockReset().mockResolvedValue(null);
    mocked.byDirectory.mockReset().mockResolvedValue([]);
    summaryAggregator.clear();
    summaryAggregator.setOnCleared(() => {});
    summaryAggregator.setOnSessionIdle(() => {});
  });

  afterEach(() => {
    stopTopicEventBus();
    summaryAggregator.clear();
  });

  it("routes a background topic event through its runtime context while another session owns foreground focus", async () => {
    const event = {
      type: "session.idle",
      properties: { sessionID: "session-a" },
    } as unknown as Event;

    mocked.bySession.mockImplementation((sessionId: string) =>
      Promise.resolve(
        sessionId === "session-a"
          ? {
              chatId: 100,
              threadId: 11,
              sessionId: "session-a",
              directory: "/workspace",
            }
          : null,
      ),
    );
    mocked.subscribe.mockImplementationOnce(
      async (_parameters: unknown, options: { signal: AbortSignal }) => ({
        stream: createStream([event], options.signal),
      }),
    );

    const onSessionIdle = vi.fn();
    summaryAggregator.setOnSessionIdle(onSessionIdle);

    // Keep A tracked, then move the process-wide foreground focus to B. Without
    // the Topic runtime context restored by topic-event-bus, the aggregator
    // would classify A as a non-active tracked session and skip this callback.
    summaryAggregator.setSession("session-a");
    summaryAggregator.setSession("session-b");

    subscribeToTopicEvents(
      "/workspace",
      (incomingEvent) => summaryAggregator.processEvent(incomingEvent),
      "session-a",
    );

    await vi.waitFor(() => {
      expect(onSessionIdle).toHaveBeenCalledTimes(1);
      expect(onSessionIdle).toHaveBeenCalledWith("session-a");
    });
  });
});
