import type { Event } from "@opencode-ai/sdk/v2";
import { opencodeClient } from "./client.js";
import { logger } from "../utils/logger.js";
import { isRecord } from "../utils/type-guards.js";
import { isExpectedOpencodeUnavailableError } from "../utils/opencode-error.js";
import { agentArtifactDeliveryService } from "../bot/services/agent-artifact-delivery-service.js";
import { isDeterministicProviderRetryError } from "./provider-error-policy.js";
import { findTelegramTopicBindingByDirectory, findTelegramTopicBindingBySessionId } from "../app/services/telegram-topic-store.js";
import { runInTopicRuntimeContext } from "../app/services/topic-runtime-context.js";

export type TopicEventCallback = (event: Event) => void | Promise<void>;
type EventLike = { type: string; properties: Record<string, unknown> };
interface Subscriber { directory: string; callback: TopicEventCallback; }
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 15000;
const FATAL_NO_STREAM_ERROR = "No stream returned from event subscription";
const SSE_IDLE_TIMEOUT_ERROR = "SSE stream idle timeout";
let sseIdleTimeoutMs = 120_000;
const subscribers = new Map<string, Subscriber>();
let listenerPromise: Promise<void> | null = null;
let controller: AbortController | null = null;
let generation = 0;
const abortedRetrySessions = new Set<string>();

function normalizeDirectory(directory: string): string { return directory.replace(/\\/g, "/").replace(/\/+$/u, "").toLowerCase(); }
function subscriberKey(directory: string, callback: TopicEventCallback): string { return `${normalizeDirectory(directory)}:${String(callback)}`; }
function isEventLike(value: unknown): value is EventLike { return isRecord(value) && typeof value.type === "string" && isRecord(value.properties); }
function getSessionId(event: EventLike): string | null { const p = event.properties; const candidates: unknown[] = [p["sessionID"], p["sessionId"], p["id"]]; if (isRecord(p["info"])) candidates.push(p["info"]["sessionID"], p["info"]["sessionId"]); if (isRecord(p["part"])) candidates.push(p["part"]["sessionID"], p["part"]["sessionId"]); return candidates.find((value): value is string => typeof value === "string" && value.length > 0) ?? null; }
function getReconnectDelayMs(attempt: number): number { return Math.min(RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1), RECONNECT_MAX_DELAY_MS); }
function wait(ms: number, signal: AbortSignal): Promise<boolean> { return new Promise((resolve) => { if (signal.aborted) return resolve(false); const onAbort = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); resolve(false); }; const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(true); }, ms); signal.addEventListener("abort", onAbort, { once: true }); }); }
function abortDeterministicRetrySession(sessionId: string, message: string, directory: string, attempt?: number): void { if (abortedRetrySessions.has(sessionId)) return; abortedRetrySessions.add(sessionId); logger.warn(`[ProviderPolicy] Aborting non-retryable provider error: session=${sessionId} attempt=${attempt ?? "n/a"} message=${message}`); if (!directory) return; void opencodeClient.session.abort({ sessionID: sessionId, directory }).catch((error) => logger.warn(`[ProviderPolicy] Exception aborting deterministic retry session=${sessionId}`, error)); }
function dispatchToSubscribers(event: EventLike, sourceDirectory?: string): void {
  void (async () => {
    const sessionId = getSessionId(event);
    let binding = sessionId ? await findTelegramTopicBindingBySessionId(sessionId) : null;
    if (!binding && sourceDirectory) binding = await findTelegramTopicBindingByDirectory(sourceDirectory);
    const targets = [...subscribers.values()].filter((subscriber) => binding ? normalizeDirectory(subscriber.directory) === normalizeDirectory(binding.directory) : !!sourceDirectory && normalizeDirectory(subscriber.directory) === normalizeDirectory(sourceDirectory));
    if (targets.length === 0) return;
    const sdkEvent = event as unknown as Event;
    agentArtifactDeliveryService.processEvent(sdkEvent);
    for (const target of targets) {
      const invoke = async () => { try { await target.callback(sdkEvent); } catch (error) { logger.error(`[TopicEventBus] Subscriber callback failed: directory=${target.directory}`, error); } };
      if (binding) await runInTopicRuntimeContext({ chatId: binding.chatId, threadId: binding.threadId, sessionId: binding.sessionId }, invoke); else await invoke();
    }
  })();
}
async function startGlobalListener(localGeneration: number, localController: AbortController): Promise<void> {
  let reconnectAttempt = 0;
  while (controller === localController && !localController.signal.aborted && generation === localGeneration && subscribers.size > 0) {
    try {
      const globalEvents = (opencodeClient as typeof opencodeClient & { global?: { event?: (options?: { signal?: AbortSignal }) => Promise<{ stream?: AsyncGenerator<unknown, unknown, unknown> | null }> } }).global;
      if (!globalEvents?.event) throw new Error("Global event subscription is not available");
      const result = await globalEvents.event({ signal: localController.signal });
      if (!result.stream) throw new Error(FATAL_NO_STREAM_ERROR);
      reconnectAttempt = 0;
      logger.info(`[SessionTrace] phase=topic_global_stream_active generation=${localGeneration}`);
      for await (const rawEvent of result.stream) {
        if (localController.signal.aborted || controller !== localController || generation !== localGeneration) break;
        if (!isEventLike(rawEvent)) continue;
        const retryStatus = isRecord(rawEvent.properties["status"]) ? rawEvent.properties["status"] : null;
        const retrySessionId = rawEvent.properties["sessionID"];
        if (rawEvent.type === "session.status" && typeof retrySessionId === "string" && retryStatus && retryStatus["type"] === "retry" && typeof retryStatus["message"] === "string" && isDeterministicProviderRetryError(retryStatus["message"])) {
          const binding = await findTelegramTopicBindingBySessionId(retrySessionId);
          abortDeterministicRetrySession(retrySessionId, retryStatus["message"], binding?.directory ?? "", typeof retryStatus["attempt"] === "number" ? retryStatus["attempt"] : undefined);
          continue;
        }
        dispatchToSubscribers(rawEvent);
      }
    } catch (error) {
      if (localController.signal.aborted || controller !== localController || generation !== localGeneration) break;
      if (!(error instanceof Error && (error.message === "SSE aborted" || error.message === SSE_IDLE_TIMEOUT_ERROR)) && !isExpectedOpencodeUnavailableError(error)) logger.warn("[TopicEventBus] Global event stream failed; retrying", error);
      reconnectAttempt++;
      if (!(await wait(getReconnectDelayMs(reconnectAttempt), localController.signal))) break;
    }
  }
}
export function subscribeToTopicEvents(directory: string, callback: TopicEventCallback): () => void { const key = subscriberKey(directory, callback); subscribers.set(key, { directory, callback }); if (!listenerPromise) { controller = new AbortController(); const localController = controller; const localGeneration = ++generation; listenerPromise = startGlobalListener(localGeneration, localController).finally(() => { if (controller === localController) { controller = null; listenerPromise = null; } }); } return () => { subscribers.delete(key); if (subscribers.size === 0) stopTopicEventBus(); }; }
export function stopTopicEventBus(): void { generation++; controller?.abort(); controller = null; listenerPromise = null; subscribers.clear(); abortedRetrySessions.clear(); logger.info(`[SessionTrace] phase=topic_event_bus_stopped generation=${generation}`); }
export function setTopicEventBusIdleTimeoutForTests(timeoutMs: number): void { sseIdleTimeoutMs = timeoutMs; }
