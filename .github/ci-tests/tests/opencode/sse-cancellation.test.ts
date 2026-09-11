import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const subscribeMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/opencode/client.js", () => ({
  opencodeClient: {
    event: { subscribe: subscribeMock },
    session: { abort: vi.fn() },
  },
}));

vi.mock("../../src/app/services/telegram-topic-store.js", () => ({
  findTelegramTopicBindingByDirectory: vi.fn().mockResolvedValue(null),
  findTelegramTopicBindingBySessionId: vi.fn().mockResolvedValue(null),
  findTelegramTopicBindingsByDirectory: vi.fn().mockResolvedValue([]),
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
  subscribeToEvents,
} from "../../src/opencode/events.js";

describe("OpenCode SSE cancellation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    subscribeMock.mockReset();
    __setSseIdleTimeoutForTests(1000);
  });

  afterEach(() => {
    stopEventListening();
    __setSseIdleTimeoutForTests(30_000);
    vi.useRealTimers();
  });

  it("aborts the timed-out connection before opening a replacement", async () => {
    let firstSignal: AbortSignal | undefined;

    subscribeMock
      .mockImplementationOnce(async (_parameters: unknown, params: { signal?: AbortSignal }) => {
        firstSignal = params.signal;
        return {
          stream: (async function* () {
            await new Promise<void>(() => undefined);
            yield undefined as never;
          })(),
        };
      })
      .mockImplementationOnce(async (_parameters: unknown, params: { signal?: AbortSignal }) => ({
        stream: (async function* () {
          while (!params.signal?.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        })(),
      }));

    const subscription = subscribeToEvents("D:/repo", vi.fn());

    await vi.advanceTimersByTimeAsync(2000);

    expect(subscribeMock).toHaveBeenCalledTimes(2);
    expect(firstSignal?.aborted).toBe(true);
    const secondSignal = subscribeMock.mock.calls[1]?.[1]?.signal as AbortSignal | undefined;
    expect(secondSignal).toBeDefined();
    expect(secondSignal).not.toBe(firstSignal);
    expect(secondSignal?.aborted).toBe(false);

    stopEventListening();
    await subscription;
  });
});
