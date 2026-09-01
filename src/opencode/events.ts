import { opencodeClient } from "./client.js";
import { Event } from "@opencode-ai/sdk/v2";
import { logger } from "../utils/logger.js";
import { isRecord } from "../utils/type-guards.js";
import { isExpectedOpencodeUnavailableError } from "../utils/opencode-error.js";
import { agentArtifactDeliveryService } from "../bot/services/agent-artifact-delivery-service.js";

type EventCallback = (event: Event) => void;
type EventStreamSource = "global" | "legacy";
type EventStreamSubscription = {
  source: EventStreamSource;
  stream: AsyncGenerator<unknown, unknown, unknown>;
};
type EventSubscriptionResult = {
  stream?: AsyncGenerator<unknown, unknown, unknown> | null;
};
type OptionalGlobalEventApi = {
  event?: (options?: { signal?: AbortSignal }) => Promise<EventSubscriptionResult>;
};
type OptionalGlobalEventClient = {
  global?: OptionalGlobalEventApi;
};

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 15000;
let sseIdleTimeoutMs = 30_000;
const FATAL_NO_STREAM_ERROR = "No stream returned from event subscription";
const SSE_IDLE_TIMEOUT_ERROR = "SSE stream idle timeout";

let eventStream: AsyncGenerator<unknown, unknown, unknown> | null = null;
let eventCallback: EventCallback | null = null;
let isListening = false;
let activeDirectory: string | null = null;
let streamAbortController: AbortController | null = null;
let listenerGeneration = 0;
let consecutiveTimeouts = 0;

function traceEvent(event: Event, phase: string): void {
  const properties = isRecord(event.properties) ? event.properties : {};
  const sessionId =
    typeof properties.sessionID === "string"
      ? properties.sessionID
      : typeof properties.sessionId === "string"
        ? properties.sessionId
        : typeof properties.id === "string"
          ? properties.id
          : "unknown";
  logger.info(`[SessionTrace] phase=${phase} event=${event.type} session=${sessionId}`);
}

type StreamReadResult =
  | { type: "next"; result: IteratorResult<unknown, unknown> }
  | { type: "error"; error: unknown }
  | { type: "aborted" }
  | { type: "timeout" };

function getReconnectDelayMs(attempt: number): number {
  const exponentialDelay = RECONNECT_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(exponentialDelay, RECONNECT_MAX_DELAY_MS);
}

function waitWithAbort(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }

    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    };

    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function createAttemptAbortController(parentSignal: AbortSignal): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();

  if (parentSignal.aborted) {
    controller.abort();
    return { controller, cleanup: () => {} };
  }

  const onAbort = () => controller.abort();
  parentSignal.addEventListener("abort", onAbort, { once: true });

  return {
    controller,
    cleanup: () => parentSignal.removeEventListener("abort", onAbort),
  };
}

function readStreamWithIdleTimeout(
  stream: AsyncGenerator<unknown, unknown, unknown>,
  signal: AbortSignal,
): Promise<StreamReadResult> {
  return new Promise((resolve) => {
    let settled = false;
    const startedAt = Date.now();
    const finish = (result: StreamReadResult) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      const elapsedMs = Date.now() - startedAt;
      if (result.type === "timeout") {
        logger.warn(`[SessionTrace] phase=stream_read_timeout elapsedMs=${elapsedMs}`);
      } else if (result.type === "error") {
        logger.warn(`[SessionTrace] phase=stream_read_error elapsedMs=${elapsedMs}`);
      } else if (result.type === "aborted") {
        logger.info(`[SessionTrace] phase=stream_read_aborted elapsedMs=${elapsedMs}`);
      }
      resolve(result);
    };

    const onAbort = () => finish({ type: "aborted" });
    const timeout = setTimeout(() => finish({ type: "timeout" }), sseIdleTimeoutMs);

    if (signal.aborted) {
      finish({ type: "aborted" });
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });

    stream.next().then(
      (result) => finish({ type: "next", result }),
      (error) => finish({ type: "error", error }),
    );
  });
}

function isEventStreamIdleTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message === SSE_IDLE_TIMEOUT_ERROR;
}

function isEventLike(value: unknown): value is Event {
  return isRecord(value) && typeof value.type === "string" && isRecord(value.properties);
}

function normalizeDirectoryForComparison(directory: string): string {
  const normalized = directory.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:/i.test(normalized) ? normalized.toLowerCase() : normalized;
}

function isSameDirectory(left: string, right: string): boolean {
  return normalizeDirectoryForComparison(left) === normalizeDirectoryForComparison(right);
}

function normalizeGlobalEvent(rawEvent: unknown, directory: string): Event | null {
  if (isEventLike(rawEvent)) {
    return rawEvent;
  }

  if (!isRecord(rawEvent) || !("payload" in rawEvent)) {
    logger.debug("[Events] Ignoring global event with unknown shape");
    return null;
  }

  const eventDirectory = typeof rawEvent.directory === "string" ? rawEvent.directory : null;
  if (eventDirectory && !isSameDirectory(eventDirectory, directory)) {
    return null;
  }

  if (!isEventLike(rawEvent.payload)) {
    logger.debug("[Events] Ignoring global event with unknown payload shape");
    return null;
  }

  return rawEvent.payload;
}

function normalizeEvent(rawEvent: unknown, source: EventStreamSource, directory: string): Event | null {
  if (source === "global") {
    return normalizeGlobalEvent(rawEvent, directory);
  }

  if (!isEventLike(rawEvent)) {
    logger.debug("[Events] Ignoring legacy event with unknown shape");
    return null;
  }

  return rawEvent;
}

async function subscribeToGlobalEventStream(signal: AbortSignal): Promise<EventStreamSubscription> {
  const globalEvents = (opencodeClient as OptionalGlobalEventClient).global;
  if (!globalEvents?.event) {
    throw new Error("Global event subscription is not available");
  }

  logger.info("[SessionTrace] phase=subscribe_global_start");
  const result = await globalEvents.event({ signal });
  if (!result.stream) {
    logger.error("[SessionTrace] phase=subscribe_global_no_stream");
    throw new Error(FATAL_NO_STREAM_ERROR);
  }

  logger.info("[SessionTrace] phase=subscribe_global_success");
  return { source: "global", stream: result.stream };
}

async function subscribeToLegacyEventStream(
  directory: string,
  signal: AbortSignal,
): Promise<EventStreamSubscription> {
  logger.info(`[SessionTrace] phase=subscribe_legacy_start directory=${directory}`);
  const result = await opencodeClient.event.subscribe({ directory }, { signal });

  if (!result.stream) {
    logger.error(`[SessionTrace] phase=subscribe_legacy_no_stream directory=${directory}`);
    throw new Error(FATAL_NO_STREAM_ERROR);
  }

  logger.info(`[SessionTrace] phase=subscribe_legacy_success directory=${directory}`);
  return { source: "legacy", stream: result.stream };
}

export async function subscribeToEvents(directory: string, callback: EventCallback): Promise<void> {
  if (isListening && activeDirectory === directory) {
    eventCallback = callback;
    logger.debug(`Event listener already running for ${directory}`);
    return;
  }

  if (isListening && activeDirectory !== directory) {
    logger.info(`Stopping event listener for ${activeDirectory}, starting for ${directory}`);
    streamAbortController?.abort();
    streamAbortController = null;
    isListening = false;
    activeDirectory = null;
  }

  const controller = new AbortController();
  const generation = ++listenerGeneration;

  activeDirectory = directory;
  eventCallback = callback;
  isListening = true;
  streamAbortController = controller;
  logger.info(`[SessionTrace] phase=listener_started generation=${generation} directory=${directory}`);

  try {
    let reconnectAttempt = 0;
    let useLegacyEventsOnce = false;

    while (isListening && activeDirectory === directory && !controller.signal.aborted) {
      let attemptAbort: ReturnType<typeof createAttemptAbortController> | null = null;
      try {
        let subscription: EventStreamSubscription;
        attemptAbort = createAttemptAbortController(controller.signal);
        if (useLegacyEventsOnce) {
          useLegacyEventsOnce = false;
          subscription = await subscribeToLegacyEventStream(directory, attemptAbort.controller.signal);
        } else {
          try {
            subscription = await subscribeToGlobalEventStream(attemptAbort.controller.signal);
            logger.debug(`Using global OpenCode event stream for ${directory}`);
          } catch (error) {
            if (controller.signal.aborted || !isListening || activeDirectory !== directory) {
              throw error;
            }

            if (isExpectedOpencodeUnavailableError(error)) {
              throw error;
            }

            logger.warn(
              `Global event stream unavailable for ${directory}, falling back to project event stream`,
              error,
            );
            subscription = await subscribeToLegacyEventStream(directory, attemptAbort.controller.signal);
          }
        }

        reconnectAttempt = 0;
        consecutiveTimeouts = 0;
        eventStream = subscription.stream;
        logger.info(`[SessionTrace] phase=stream_active source=${subscription.source} generation=${generation}`);
        let usefulEventCount = 0;

        try {
          while (isListening && activeDirectory === directory && !controller.signal.aborted) {
            const readResult = await readStreamWithIdleTimeout(
              eventStream,
              attemptAbort.controller.signal,
            );

            if (readResult.type === "aborted") {
              logger.debug(`Event listener stopped or changed directory, breaking loop`);
              break;
            }

            if (readResult.type === "timeout") {
              logger.warn(
                `[SessionTrace] phase=sse_idle_timeout directory=${directory} timeoutMs=${sseIdleTimeoutMs} source=${subscription.source}`,
              );
              attemptAbort.controller.abort();
              const closeStream = eventStream.return?.(undefined);
              void closeStream?.catch(() => undefined);
              throw new Error(SSE_IDLE_TIMEOUT_ERROR);
            }

            if (readResult.type === "error") {
              logger.warn(`[SessionTrace] phase=stream_next_error directory=${directory}`, readResult.error);
              throw readResult.error;
            }

            if (readResult.result.done) {
              logger.warn(`[SessionTrace] phase=stream_done directory=${directory} source=${subscription.source}`);
              break;
            }

            const event = readResult.result.value;

            await new Promise<void>((resolve) => setImmediate(resolve));

            const normalizedEvent = normalizeEvent(event, subscription.source, directory);
            if (!normalizedEvent) {
              continue;
            }

            traceEvent(normalizedEvent, "event_received");
            agentArtifactDeliveryService.processEvent(normalizedEvent);

            if (normalizedEvent.type !== "server.connected") {
              usefulEventCount++;
            }

            if (eventCallback) {
              const callbackSnapshot = eventCallback;
              setImmediate(() => {
                if (
                  streamAbortController !== controller ||
                  controller.signal.aborted ||
                  !isListening ||
                  activeDirectory !== directory ||
                  listenerGeneration !== generation
                ) {
                  logger.warn(
                    `[SessionTrace] phase=callback_dropped event=${normalizedEvent.type} generation=${generation} currentGeneration=${listenerGeneration}`,
                  );
                  return;
                }

                try {
                  traceEvent(normalizedEvent, "callback_dispatch");
                  callbackSnapshot(normalizedEvent);
                } catch (error) {
                  logger.error("[Events] Callback failed:", error);
                }
              });
            } else {
              logger.warn(`[SessionTrace] phase=callback_missing event=${normalizedEvent.type}`);
            }
          }
        } finally {
          attemptAbort.cleanup();
        }

        eventStream = null;

        if (!isListening || activeDirectory !== directory || controller.signal.aborted) {
          break;
        }

        if (subscription.source === "global" && usefulEventCount === 0) {
          useLegacyEventsOnce = true;
          logger.warn(
            `[SessionTrace] phase=global_empty_fallback directory=${directory}`,
          );
          continue;
        }

        reconnectAttempt++;
        consecutiveTimeouts = 0;
        const reconnectDelay = getReconnectDelayMs(reconnectAttempt);
        logger.warn(
          `[SessionTrace] phase=stream_reconnect directory=${directory} reason=ended delayMs=${reconnectDelay} attempt=${reconnectAttempt}`,
        );

        const shouldContinue = await waitWithAbort(reconnectDelay, controller.signal);
        if (!shouldContinue) {
          break;
        }
      } catch (error) {
        attemptAbort?.cleanup();
        eventStream = null;

        if (controller.signal.aborted || !isListening || activeDirectory !== directory) {
          logger.info(`[SessionTrace] phase=listener_aborted directory=${directory}`);
          return;
        }

        if (error instanceof Error && error.message === FATAL_NO_STREAM_ERROR) {
          logger.error("Event stream fatal error:", error);
          throw error;
        }

        reconnectAttempt++;
        consecutiveTimeouts++;
        const reconnectDelay = getReconnectDelayMs(reconnectAttempt);
        if (isEventStreamIdleTimeoutError(error)) {
          const timeoutWarning =
            consecutiveTimeouts >= 5
              ? ` (${consecutiveTimeouts} consecutive timeouts — OpenCode server may be unreachable)`
              : "";
          logger.warn(
            `[SessionTrace] phase=reconnect_after_idle_timeout directory=${directory} delayMs=${reconnectDelay} attempt=${reconnectAttempt}${timeoutWarning}`,
          );
        } else if (isExpectedOpencodeUnavailableError(error)) {
          logger.warn(
            `[SessionTrace] phase=reconnect_after_unavailable directory=${directory} delayMs=${reconnectDelay} attempt=${reconnectAttempt}`,
          );
        } else {
          logger.error(
            `[SessionTrace] phase=reconnect_after_error directory=${directory} delayMs=${reconnectDelay} attempt=${reconnectAttempt}`,
            error,
          );
        }

        const shouldContinue = await waitWithAbort(reconnectDelay, controller.signal);
        if (!shouldContinue) {
          break;
        }
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      logger.info(`[SessionTrace] phase=listener_aborted_outer directory=${directory}`);
      return;
    }

    if (isExpectedOpencodeUnavailableError(error)) {
      logger.warn(`[SessionTrace] phase=listener_unavailable_stopped directory=${directory}`);
    } else {
      logger.error(`[SessionTrace] phase=listener_fatal_error directory=${directory}`, error);
    }
    isListening = false;
    activeDirectory = null;
    streamAbortController = null;
    throw error;
  } finally {
    if (streamAbortController === controller) {
      if (isListening && activeDirectory === directory && !controller.signal.aborted) {
        logger.warn(`[SessionTrace] phase=listener_disconnected directory=${directory}`);
      }

      streamAbortController = null;
      eventStream = null;
      eventCallback = null;
      isListening = false;
      activeDirectory = null;
      logger.info(`[SessionTrace] phase=listener_stopped directory=${directory} generation=${generation}`);
    }
  }
}

export function stopEventListening(): void {
  listenerGeneration++;
  streamAbortController?.abort();
  streamAbortController = null;
  isListening = false;
  eventCallback = null;
  eventStream = null;
  activeDirectory = null;
  agentArtifactDeliveryService.clear();
  logger.info(`[SessionTrace] phase=listener_stop_requested generation=${listenerGeneration}`);
  logger.info("Event listener stopped");
}

export function __setSseIdleTimeoutForTests(timeoutMs: number): void {
  sseIdleTimeoutMs = timeoutMs;
}
