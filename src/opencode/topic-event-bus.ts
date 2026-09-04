import type { Event } from "@opencode-ai/sdk/v2";
import { opencodeClient } from "./client.js";
import { logger } from "../utils/logger.js";
import { isRecord } from "../utils/type-guards.js";
import { isExpectedOpencodeUnavailableError } from "../utils/opencode-error.js";
import { agentArtifactDeliveryService } from "../bot/services/agent-artifact-delivery-service.js";
import { isDeterministicProviderRetryError } from "./provider-error-policy.js";
import { findTelegramTopicBindingsByDirectory, findTelegramTopicBindingBySessionId } from "../app/services/telegram-topic-store.js";
import { runInTopicRuntimeContext } from "../app/services/topic-runtime-context.js";
import { topicTelemetry } from "../utils/topic-observability.js";

export type TopicEventCallback = (event: Event) => void | Promise<void>;
type EventLike = { type: string; properties: Record<string, unknown> };
interface Subscriber { directory: string; sessionId?: string; callback: TopicEventCallback; }
interface DirectoryListener { directory: string; controller: AbortController; promise: Promise<void>; }
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 15000;
const FATAL_NO_STREAM_ERROR = "No stream returned from event subscription";
const SSE_IDLE_TIMEOUT_ERROR = "SSE stream idle timeout";
const subscribers = new Map<string, Subscriber>();
const directoryListeners = new Map<string, DirectoryListener>();
const abortedRetrySessions = new Set<string>();
function normalizeDirectory(directory: string): string { return directory.replace(/\\/g, "/").replace(/\/+$/u, "").toLowerCase(); }
function subscriberKey(directory: string, callback: TopicEventCallback, sessionId?: string): string { return `${normalizeDirectory(directory)}:${sessionId ?? "*"}:${String(callback)}`; }
function isEventLike(value: unknown): value is EventLike { return isRecord(value) && typeof value.type === "string" && isRecord(value.properties); }
function getSessionId(event: EventLike): string | null { const p = event.properties; const candidates: unknown[] = [p["sessionID"], p["sessionId"], p["id"]]; if (isRecord(p["info"])) candidates.push(p["info"]["sessionID"], p["info"]["sessionId"]); if (isRecord(p["part"])) candidates.push(p["part"]["sessionID"], p["part"]["sessionId"]); if (isRecord(p["message"])) candidates.push(p["message"]["sessionID"], p["message"]["sessionId"]); return candidates.find((value): value is string => typeof value === "string" && value.length > 0) ?? null; }
function getEventDirectory(event: EventLike): string | null { const candidates: unknown[] = [event.properties["directory"], event.properties["worktree"]]; if (isRecord(event.properties["info"])) candidates.push(event.properties["info"]["directory"], event.properties["info"]["worktree"]); if (isRecord(event.properties["part"])) candidates.push(event.properties["part"]["directory"], event.properties["part"]["worktree"]); return candidates.find((value): value is string => typeof value === "string" && value.length > 0) ?? null; }
function getReconnectDelayMs(attempt: number): number { return Math.min(RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1), RECONNECT_MAX_DELAY_MS); }
function wait(ms: number, signal: AbortSignal): Promise<boolean> { return new Promise((resolve) => { if (signal.aborted) return resolve(false); const onAbort = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); resolve(false); }; const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(true); }, ms); signal.addEventListener("abort", onAbort, { once: true }); }); }
function abortDeterministicRetrySession(sessionId: string, message: string, directory: string, attempt?: number): void { if (abortedRetrySessions.has(sessionId)) return; abortedRetrySessions.add(sessionId); logger.warn(`[ProviderPolicy] Aborting non-retryable provider error: session=${sessionId} attempt=${attempt ?? "n/a"} message=${message}`); if (!directory) return; void opencodeClient.session.abort({ sessionID: sessionId, directory }).catch((error) => logger.warn(`[ProviderPolicy] Exception aborting deterministic retry session=${sessionId}`, error)); }
function dispatchToSubscribers(event: EventLike, scopedDirectory?: string): void { void (async () => {
  const sessionId = getSessionId(event);
  const eventDirectory = getEventDirectory(event);
  let binding = sessionId ? await findTelegramTopicBindingBySessionId(sessionId) : null;
  let directoryBindingCount = 0;
  if (!binding) {
    const directoryForLookup = scopedDirectory ?? eventDirectory;
    if (directoryForLookup) {
      const directoryBindings = await findTelegramTopicBindingsByDirectory(directoryForLookup);
      directoryBindingCount = directoryBindings.length;
      if (directoryBindings.length === 1) binding = directoryBindings[0] ?? null;
      else if (directoryBindings.length > 1 && sessionId) binding = directoryBindings.find((candidate) => candidate.sessionId === sessionId) ?? null;
      else if (directoryBindings.length > 1) { topicTelemetry("ambiguous_directory_route_blocked", { directory: directoryForLookup }, { type: event.type, bindingCount: directoryBindings.length }); return; }
    }
  }
  const effectiveDirectory = normalizeDirectory(scopedDirectory ?? eventDirectory ?? binding?.directory ?? "");
  const targets = [...subscribers.values()].filter((subscriber) => {
    if (effectiveDirectory && normalizeDirectory(subscriber.directory) !== effectiveDirectory) return false;
    if (binding) return !subscriber.sessionId || subscriber.sessionId === binding.sessionId;
    return !subscriber.sessionId || subscriber.sessionId === sessionId;
  });
  topicTelemetry("event_seen", { chatId: binding?.chatId, threadId: binding?.threadId, sessionId: binding?.sessionId ?? sessionId ?? undefined, directory: binding?.directory ?? eventDirectory ?? scopedDirectory ?? undefined }, { type: event.type, targets: targets.length, directoryBindingCount, routed: targets.length > 0 });
  if (targets.length === 0) return;
  topicTelemetry("event_dispatch", { chatId: binding?.chatId, threadId: binding?.threadId, sessionId: binding?.sessionId ?? sessionId ?? undefined, directory: binding?.directory ?? eventDirectory ?? scopedDirectory ?? undefined }, { type: event.type, targets: targets.length, directoryBindingCount });
  const sdkEvent = event as unknown as Event;
  for (const target of targets) {
    const invoke = async () => { try { await agentArtifactDeliveryService.processEvent(sdkEvent); await target.callback(sdkEvent); } catch (error) { logger.error(`[TopicEventBus] Subscriber callback failed: directory=${target.directory} session=${target.sessionId ?? "all"}`, error); } };
    if (binding && (!target.sessionId || target.sessionId === binding.sessionId)) await runInTopicRuntimeContext({ chatId: binding.chatId, threadId: binding.threadId, sessionId: binding.sessionId }, invoke); else await invoke();
  }
})(); }
async function startDirectoryListener(directory: string, localController: AbortController): Promise<void> {
  let reconnectAttempt = 0;
  const normalized = normalizeDirectory(directory);
  while (!localController.signal.aborted && directoryListeners.get(normalized)?.controller === localController && subscribersForDirectory(normalized).length > 0) {
    try {
      const clientWithEvent = opencodeClient as typeof opencodeClient & { event?: { subscribe: (options?: { directory?: string; signal?: AbortSignal }) => Promise<{ stream?: AsyncGenerator<unknown, unknown, unknown> | null }> } };
      const eventApi = clientWithEvent.event;
      if (!eventApi?.subscribe) { logger.warn(`[TopicEventBus] OpenCode event.subscribe API is unavailable; directory=${directory}`); return; }
      logger.info(`[SessionTrace] phase=topic_directory_stream_connecting directory=${directory}`);
      const result = await eventApi.subscribe({ directory, signal: localController.signal });
      if (!result.stream) throw new Error(FATAL_NO_STREAM_ERROR);
      reconnectAttempt = 0;
      logger.info(`[SessionTrace] phase=topic_directory_stream_active directory=${directory}`);
      topicTelemetry("directory_stream_active", { directory }, { subscriberCount: subscribersForDirectory(normalized).length });
      for await (const rawEvent of result.stream) {
        if (localController.signal.aborted || directoryListeners.get(normalized)?.controller !== localController) break;
        if (!isEventLike(rawEvent)) continue;
        const retryStatus = isRecord(rawEvent.properties["status"]) ? rawEvent.properties["status"] : null;
        const retrySessionId = rawEvent.properties["sessionID"];
        if (rawEvent.type === "session.status" && typeof retrySessionId === "string" && retryStatus && retryStatus["type"] === "retry" && typeof retryStatus["message"] === "string" && isDeterministicProviderRetryError(retryStatus["message"])) { abortDeterministicRetrySession(retrySessionId, retryStatus["message"], directory, typeof retryStatus["attempt"] === "number" ? retryStatus["attempt"] : undefined); continue; }
        dispatchToSubscribers(rawEvent, directory);
      }
    } catch (error) {
      if (localController.signal.aborted || directoryListeners.get(normalized)?.controller !== localController) break;
      if (!(error instanceof Error && (error.message === "SSE aborted" || error.message === SSE_IDLE_TIMEOUT_ERROR)) && !isExpectedOpencodeUnavailableError(error)) logger.warn(`[TopicEventBus] Directory event stream failed; retrying: directory=${directory}`, error);
      reconnectAttempt++;
      if (!(await wait(getReconnectDelayMs(reconnectAttempt), localController.signal))) break;
    }
  }
}
function subscribersForDirectory(normalizedDirectory: string): Subscriber[] { return [...subscribers.values()].filter((subscriber) => normalizeDirectory(subscriber.directory) === normalizedDirectory); }
function ensureDirectoryListener(directory: string): void {
  const normalized = normalizeDirectory(directory);
  if (directoryListeners.has(normalized)) return;
  const controller = new AbortController();
  const listener: DirectoryListener = { directory, controller, promise: Promise.resolve() };
  directoryListeners.set(normalized, listener);
  listener.promise = startDirectoryListener(directory, controller).finally(() => { if (directoryListeners.get(normalized)?.controller === controller) directoryListeners.delete(normalized); });
}
function stopDirectoryListenerIfUnused(directory: string): void { const normalized = normalizeDirectory(directory); if (subscribersForDirectory(normalized).length > 0) return; const listener = directoryListeners.get(normalized); if (!listener) return; listener.controller.abort(); directoryListeners.delete(normalized); }
export function subscribeToTopicEvents(directory: string, callback: TopicEventCallback, sessionId?: string): () => void { const key = subscriberKey(directory, callback, sessionId); subscribers.set(key, { directory, sessionId, callback }); topicTelemetry("subscription_added", { sessionId, directory }, { subscriberCount: subscribers.size, scoped: sessionId !== undefined }); ensureDirectoryListener(directory); return () => { if (subscribers.delete(key)) { topicTelemetry("subscription_removed", { sessionId, directory }, { subscriberCount: subscribers.size }); stopDirectoryListenerIfUnused(directory); } }; }
export function stopTopicEventSubscription(directory: string, sessionId?: string): void { const normalized = normalizeDirectory(directory); let removed = 0; for (const [key, subscriber] of subscribers) { if (normalizeDirectory(subscriber.directory) !== normalized) continue; if (sessionId !== undefined && subscriber.sessionId !== sessionId) continue; subscribers.delete(key); removed++; } if (removed > 0) topicTelemetry("subscription_batch_removed", { sessionId, directory }, { removed, subscriberCount: subscribers.size }); stopDirectoryListenerIfUnused(directory); }
export function stopTopicEventBus(): void { const previousSubscriberCount = subscribers.size; for (const listener of directoryListeners.values()) listener.controller.abort(); directoryListeners.clear(); subscribers.clear(); abortedRetrySessions.clear(); logger.info(`[SessionTrace] phase=topic_event_bus_stopped`); topicTelemetry("global_stream_stopped", {}, { previousSubscriberCount }); }
export function setTopicEventBusIdleTimeoutForTests(_timeoutMs: number): void {}
