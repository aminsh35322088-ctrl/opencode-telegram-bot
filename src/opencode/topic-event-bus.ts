import type { Event } from "@opencode-ai/sdk/v2";
import { opencodeClient } from "./client.js";
import { logger } from "../utils/logger.js";
import { isRecord } from "../utils/type-guards.js";
import { isExpectedOpencodeUnavailableError } from "../utils/opencode-error.js";
import { agentArtifactDeliveryService } from "../bot/services/agent-artifact-delivery-service.js";
import { isDeterministicProviderRetryError } from "./provider-error-policy.js";
import { isCurrentCoreSessionRoute, resolveCoreEventRoute } from "../core/native-core-service.js";
import { resolveTopicNodeClient } from "../control-plane/topic-node-client.js";
import { nodeBindings } from "../control-plane/node-bindings.js";
import { getTopicRuntimeContext, type TopicRuntimeContext } from "../app/services/topic-runtime-context.js";
import { runInTopicRuntimeContext } from "../app/services/topic-runtime-context.js";
import { topicTelemetry } from "../utils/topic-observability.js";
import { markAbortExpected } from "../app/managers/abort-suppression-manager.js";

export type TopicEventCallback = (event: Event) => void | Promise<void>;
type EventLike = { type: string; properties: Record<string, unknown> };
interface Subscriber { directory: string; sessionId?: string; callback: TopicEventCallback; }
interface DirectoryListener { directory: string; controller: AbortController; promise: Promise<void>; }
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 15000;
const DEFAULT_SSE_IDLE_TIMEOUT_MS = 45000;
const FATAL_NO_STREAM_ERROR = "No stream returned from event subscription";
const SSE_IDLE_TIMEOUT_ERROR = "SSE stream idle timeout";
const subscribers = new Map<string, Subscriber>();
const directoryListeners = new Map<string, DirectoryListener>();
const dispatchChains = new Map<string, Promise<void>>();
const abortedRetrySessions = new Set<string>();
// Only retired root sessions are rejected; unknown child sessions still need
// the unique-directory route for subagent progress. Reattachment reactivates a root.
const retiredSessions = new Set<string>();
const sessionGenerations = new Map<string, object>();
let busGeneration = {};
let sseIdleTimeoutMs = DEFAULT_SSE_IDLE_TIMEOUT_MS;
function normalizeDirectory(directory: string): string { return directory.replace(/\\/g, "/").replace(/\/+$/u, "").toLowerCase(); }
function subscriberKey(directory: string, callback: TopicEventCallback, sessionId?: string): string { return `${normalizeDirectory(directory)}:${sessionId ?? "*"}:${String(callback)}`; }
function isEventLike(value: unknown): value is EventLike { return isRecord(value) && typeof value.type === "string" && isRecord(value.properties); }
function getSessionId(event: EventLike): string | null { const p = event.properties; const candidates: unknown[] = [p["sessionID"], p["sessionId"], p["id"]]; if (isRecord(p["info"])) { if (event.type.startsWith("session.")) candidates.push(p["info"]["id"]); candidates.push(p["info"]["sessionID"], p["info"]["sessionId"]); } if (isRecord(p["part"])) candidates.push(p["part"]["sessionID"], p["part"]["sessionId"]); if (isRecord(p["message"])) candidates.push(p["message"]["sessionID"], p["message"]["sessionId"]); return candidates.find((value): value is string => typeof value === "string" && value.length > 0) ?? null; }
function getEventDirectory(event: EventLike): string | null { const candidates: unknown[] = [event.properties["directory"], event.properties["worktree"]]; if (isRecord(event.properties["info"])) candidates.push(event.properties["info"]["directory"], event.properties["info"]["worktree"]); if (isRecord(event.properties["part"])) candidates.push(event.properties["part"]["directory"], event.properties["part"]["worktree"]); return candidates.find((value): value is string => typeof value === "string" && value.length > 0) ?? null; }
function getReconnectDelayMs(attempt: number): number { return Math.min(RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1), RECONNECT_MAX_DELAY_MS); }
function wait(ms: number, signal: AbortSignal): Promise<boolean> { return new Promise((resolve) => { if (signal.aborted) return resolve(false); const onAbort = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); resolve(false); }; const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(true); }, ms); signal.addEventListener("abort", onAbort, { once: true }); }); }
function abortDeterministicRetrySession(sessionId: string, message: string, directory: string, attempt?: number): void { if (abortedRetrySessions.has(sessionId)) return; abortedRetrySessions.add(sessionId); markAbortExpected(sessionId); logger.warn(`[ProviderPolicy] Aborting non-retryable provider error: session=${sessionId} attempt=${attempt ?? "n/a"} message=${message}`); if (!directory) return; void opencodeClient.session.abort({ sessionID: sessionId, directory }).catch((error) => logger.warn(`[ProviderPolicy] Exception aborting deterministic retry session=${sessionId}`, error)); }
async function readNextWithIdleTimeout<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  if (signal.aborted) return { done: true, value: undefined as never };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort!: () => void;
  const cancelled = new Promise<IteratorResult<T>>(resolve => {
    onAbort = () => resolve({ done: true, value: undefined as never });
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(SSE_IDLE_TIMEOUT_ERROR)), sseIdleTimeoutMs);
    });
    return await Promise.race([iterator.next(), timeout, cancelled]);
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
async function consumeEventStream(stream: AsyncGenerator<unknown, unknown, unknown>, controller: AbortController, onEvent: (event: EventLike) => void): Promise<void> { const iterator = stream[Symbol.asyncIterator](); try { while (!controller.signal.aborted) { const result = await readNextWithIdleTimeout(iterator, controller.signal); if (result.done) return; if (isEventLike(result.value)) onEvent(result.value); } } finally { controller.abort(); void iterator.return?.(undefined as never)?.catch(() => undefined); } }
function createStreamController(parentSignal: AbortSignal): { controller: AbortController; cleanup: () => void } { const controller = new AbortController(); const onAbort = () => controller.abort(parentSignal.reason); if (parentSignal.aborted) controller.abort(parentSignal.reason); else parentSignal.addEventListener("abort", onAbort, { once: true }); return { controller, cleanup: () => parentSignal.removeEventListener("abort", onAbort) }; }
async function dispatchEventToSubscribers(
  event: EventLike,
  scopedDirectory: string | undefined,
  candidates: Subscriber[],
  isCurrent: () => boolean,
): Promise<void> {
  if (!isCurrent()) return;
  const sessionId = getSessionId(event);
  if (sessionId && retiredSessions.has(sessionId)) {
    topicTelemetry("stale_session_route_blocked", { sessionId, directory: scopedDirectory }, { type: event.type });
    return;
  }
  const eventDirectory = getEventDirectory(event);
  if (scopedDirectory && eventDirectory && normalizeDirectory(scopedDirectory) !== normalizeDirectory(eventDirectory)) {
    topicTelemetry("foreign_directory_route_blocked", { sessionId: sessionId ?? undefined, directory: scopedDirectory }, { type: event.type });
    return;
  }
  const directory = scopedDirectory ?? eventDirectory;
  const binding = await resolveCoreEventRoute(sessionId, directory ?? null);
  if (!binding) {
    topicTelemetry("unresolved_core_route_blocked", { sessionId: sessionId ?? undefined, directory: directory ?? undefined }, { type: event.type });
    return;
  }
  const effectiveDirectory = normalizeDirectory(directory ?? binding.normalizedDirectory);
  const targets = candidates.filter((subscriber) => {
    if (!isCurrent() || ![...subscribers.values()].includes(subscriber)) return false;
    if (effectiveDirectory && normalizeDirectory(subscriber.directory) !== effectiveDirectory) return false;
    return !subscriber.sessionId || subscriber.sessionId === binding.sessionId;
  });
  topicTelemetry("event_seen", {
    chatId: binding.chatId,
    threadId: binding.threadId,
    sessionId: binding.sessionId,
    directory: binding.normalizedDirectory,
  }, { type: event.type, targets: targets.length, routed: targets.length > 0 }, "debug");
  if (targets.length === 0) return;
  const sdkEvent = event as unknown as Event;
  for (const target of targets) {
    const invoke = async () => {
      if (!isCurrent() || ![...subscribers.values()].includes(target)) return;
      if (!isCurrentCoreSessionRoute(binding)) return;
      try {
        agentArtifactDeliveryService.processEvent(sdkEvent);
        await target.callback(sdkEvent);
      } catch (error) {
        logger.error(`[TopicEventBus] Subscriber callback failed: directory=${target.directory} session=${target.sessionId ?? "all"}`, error);
      }
    };
    await runInTopicRuntimeContext({
      chatId: binding.chatId,
      threadId: binding.threadId,
      sessionId: binding.sessionId,
      directory: binding.normalizedDirectory,
    }, invoke);
  }
}
function dispatchKey(event: EventLike, scopedDirectory?: string): string { const sessionId = getSessionId(event); if (sessionId) return `session:${sessionId}`; return `directory:${normalizeDirectory(scopedDirectory ?? getEventDirectory(event) ?? "")}`; }
function dispatchToSubscribers(event: EventLike, scopedDirectory?: string): void {
  const key = dispatchKey(event, scopedDirectory);
  const sessionId = getSessionId(event);
  const generation = sessionId ? sessionGenerations.get(sessionId) : undefined;
  const bus = busGeneration;
  const candidates = [...subscribers.values()];
  const isCurrent = () => bus === busGeneration && (!sessionId ||
    (!retiredSessions.has(sessionId) && sessionGenerations.get(sessionId) === generation));
  if (sessionId && retiredSessions.has(sessionId)) {
    topicTelemetry("stale_session_route_blocked", { sessionId, directory: scopedDirectory }, { type: event.type });
    return;
  }
  const previous = dispatchChains.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined)
    .then(() => dispatchEventToSubscribers(event, scopedDirectory, candidates, isCurrent))
    .catch(error => logger.error(`[TopicEventBus] Event dispatch failed: key=${key}`, error));
  dispatchChains.set(key, current);
  void current.finally(() => { if (dispatchChains.get(key) === current) dispatchChains.delete(key); });
}
const MAX_RETIRED_SESSIONS = 500;

function retireSession(sessionId: string): void {
  const wasRetired = retiredSessions.has(sessionId);
  if (!wasRetired) {
    retiredSessions.add(sessionId);
    while (retiredSessions.size > MAX_RETIRED_SESSIONS) {
      const oldest = retiredSessions.values().next().value;
      if (oldest === undefined) break;
      retiredSessions.delete(oldest);
      sessionGenerations.delete(oldest);
    }
  }
  sessionGenerations.set(sessionId, {});
  while (sessionGenerations.size > MAX_RETIRED_SESSIONS * 2) {
    const oldest = sessionGenerations.keys().next().value;
    if (oldest === undefined) break;
    if (!retiredSessions.has(oldest)) { sessionGenerations.delete(oldest); continue; }
    const dropped = retiredSessions.values().next().value;
    if (dropped === undefined || dropped === oldest) break;
    retiredSessions.delete(dropped);
    sessionGenerations.delete(dropped);
  }
}
// A server may accept TCP but never return SSE headers. The stream iterator's
// idle timeout does not cover that phase, so bound connection establishment too.
async function connectWithTimeout<T>(request: () => Promise<T>, controller: AbortController): Promise<T> {
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("SSE aborted"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(SSE_IDLE_TIMEOUT_ERROR));
      controller.abort();
    }, sseIdleTimeoutMs);
  });
  if (controller.signal.aborted) onAbort();
  try { return await Promise.race([cancelled, timeout, request()]); }
  finally {
    if (timer) clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

async function startDirectoryListener(directory: string, localController: AbortController): Promise<void> { let reconnectAttempt = 0; const normalized = normalizeDirectory(directory); while (!localController.signal.aborted && directoryListeners.get(normalized)?.controller === localController && subscribersForDirectory(normalized).length > 0) { const streamContext = createStreamController(localController.signal); const streamController = streamContext.controller; try { const eventApi = opencodeClient.event; if (!eventApi?.subscribe) { logger.warn(`[TopicEventBus] OpenCode event.subscribe API is unavailable; directory=${directory}`); return; } logger.info(`[SessionTrace] phase=topic_directory_stream_connecting directory=${directory}`); const result = await connectWithTimeout(() => eventApi.subscribe({ directory }, { signal: streamController.signal }), streamController); if (!result.stream) throw new Error(FATAL_NO_STREAM_ERROR); reconnectAttempt = 0; logger.info(`[SessionTrace] phase=topic_directory_stream_active directory=${directory}`); topicTelemetry("directory_stream_active", { directory }, { subscriberCount: subscribersForDirectory(normalized).length }); await consumeEventStream(result.stream, streamController, (rawEvent) => { if (localController.signal.aborted || directoryListeners.get(normalized)?.controller !== localController) return; const retryStatus = isRecord(rawEvent.properties["status"]) ? rawEvent.properties["status"] : null; const retrySessionId = rawEvent.properties["sessionID"]; if (rawEvent.type === "session.status" && typeof retrySessionId === "string" && retryStatus && retryStatus["type"] === "retry" && typeof retryStatus["message"] === "string" && isDeterministicProviderRetryError(retryStatus["message"])) { abortDeterministicRetrySession(retrySessionId, retryStatus["message"], directory, typeof retryStatus["attempt"] === "number" ? retryStatus["attempt"] : undefined); return; } if (rawEvent.type === "session.status" && typeof retrySessionId === "string" && retryStatus && retryStatus["type"] !== "retry") abortedRetrySessions.delete(retrySessionId); dispatchToSubscribers(rawEvent, directory); }); } catch (error) { if (localController.signal.aborted || directoryListeners.get(normalized)?.controller !== localController) break; if (error instanceof Error && error.message === SSE_IDLE_TIMEOUT_ERROR) logger.warn(`[TopicEventBus] Directory event stream idle timeout; reconnecting: directory=${directory}, timeoutMs=${sseIdleTimeoutMs}`); else if (!(error instanceof Error && error.message === "SSE aborted") && !isExpectedOpencodeUnavailableError(error)) logger.warn(`[TopicEventBus] Directory event stream failed; retrying: directory=${directory}`, error); reconnectAttempt++; if (!(await wait(getReconnectDelayMs(reconnectAttempt), localController.signal))) break; } finally { streamController.abort(); streamContext.cleanup(); } } }
function subscribersForDirectory(normalizedDirectory: string): Subscriber[] { return [...subscribers.values()].filter((subscriber) => normalizeDirectory(subscriber.directory) === normalizedDirectory); }
function ensureDirectoryListener(directory: string): void { const normalized = normalizeDirectory(directory); if (directoryListeners.has(normalized)) return; const controller = new AbortController(); const listener: DirectoryListener = { directory, controller, promise: Promise.resolve() }; directoryListeners.set(normalized, listener); listener.promise = startDirectoryListener(directory, controller).finally(() => { if (directoryListeners.get(normalized)?.controller === controller) directoryListeners.delete(normalized); }); }
function stopDirectoryListenerIfUnused(directory: string): void { const normalized = normalizeDirectory(directory); if (subscribersForDirectory(normalized).length > 0) return; const listener = directoryListeners.get(normalized); if (!listener) return; listener.controller.abort(); directoryListeners.delete(normalized); }
export function subscribeToTopicEvents(directory: string, callback: TopicEventCallback, sessionId?: string): () => void { if (sessionId) retiredSessions.delete(sessionId); const key = subscriberKey(directory, callback, sessionId); subscribers.set(key, { directory, sessionId, callback }); topicTelemetry("subscription_added", { sessionId, directory }, { subscriberCount: subscribers.size, scoped: sessionId !== undefined }); const topic = getTopicRuntimeContext();
  if (topic) void nodeBindings.find(topic.chatId,topic.threadId).then(binding => { if (!binding && subscribers.has(key)) ensureDirectoryListener(directory); }).catch(error => logger.error("[TopicEventBus] Binding lookup failed",error));
  else ensureDirectoryListener(directory); return () => { if (subscribers.delete(key)) { if (sessionId && ![...subscribers.values()].some((subscriber) => subscriber.sessionId === sessionId)) retireSession(sessionId); topicTelemetry("subscription_removed", { sessionId, directory }, { subscriberCount: subscribers.size }); stopDirectoryListenerIfUnused(directory); } }; }
export function stopTopicEventSubscription(directory: string, sessionId?: string): void { if(sessionId) remoteRunStreams.get(sessionId)?.abort(); const normalized = normalizeDirectory(directory); let removed = 0; for (const [key, subscriber] of subscribers) { if (normalizeDirectory(subscriber.directory) !== normalized) continue; if (sessionId !== undefined && subscriber.sessionId !== sessionId) continue; subscribers.delete(key); if (subscriber.sessionId) retireSession(subscriber.sessionId); removed++; } if (removed > 0) topicTelemetry("subscription_batch_removed", { sessionId, directory }, { removed, subscriberCount: subscribers.size }); stopDirectoryListenerIfUnused(directory); }
export function stopTopicEventBus(): void { for(const controller of remoteRunStreams.values()) controller.abort(); remoteRunStreams.clear(); const previousSubscriberCount = subscribers.size; busGeneration = {}; sessionGenerations.clear(); for (const listener of directoryListeners.values()) listener.controller.abort(); directoryListeners.clear(); subscribers.clear(); dispatchChains.clear(); abortedRetrySessions.clear(); retiredSessions.clear(); logger.info(`[SessionTrace] phase=topic_event_bus_stopped`); topicTelemetry("global_stream_stopped", {}, { previousSubscriberCount }); }
export function setTopicEventBusIdleTimeoutForTests(timeoutMs: number): void { sseIdleTimeoutMs = Math.max(1, timeoutMs); }

const remoteRunStreams = new Map<string,AbortController>();
/** Active-run stream feeds existing subscribers under authenticated Topic context. No idle reconnect loop. */
export async function startRemoteTopicRunEvents(topic: TopicRuntimeContext, sessionId: string, directory: string, runId: string, onEnd:()=>void, mode:"prepare"|"resume"="prepare"): Promise<()=>void> {
  const client = await resolveTopicNodeClient(topic.chatId,topic.threadId);
  if (!client) throw new Error("Remote Topic missing node binding");
  if(remoteRunStreams.has(sessionId)) throw new Error("Remote Topic stream already active");
  const controller = new AbortController(); remoteRunStreams.set(sessionId,controller);
  try {
    if(mode==="prepare")await client.request("run.prepare",{runId});
    else {
      const status=await client.request<{continuation?:string;externalRunId?:string}|null>("status");
      if(status?.continuation!=="live"||status.externalRunId!==runId)throw new Error("Remote run cannot be recovered from signed status");
    }
  }catch(error){controller.abort();if(remoteRunStreams.get(sessionId)===controller)remoteRunStreams.delete(sessionId);throw error;}
  const normalized = normalizeDirectory(directory);
  const legacy = directoryListeners.get(normalized);
  legacy?.controller.abort(); directoryListeners.delete(normalized);
  let acknowledged=false;
  let acknowledge!:()=>void;
  let rejectReady!:(error:unknown)=>void;
  const ready = new Promise<void>((resolve,reject)=>{acknowledge=()=>{acknowledged=true;resolve();};rejectReady=reject;});
  const timer = setTimeout(()=>{controller.abort();rejectReady(new Error("Remote stream readiness timed out"));},15_000);
  const generation = busGeneration;
  void (async()=>{
    try {
      for await (const raw of client.events(runId,0,{signal:controller.signal,onReady:acknowledge})) {
        if(controller.signal.aborted || generation!==busGeneration) break;
        if(!isEventLike(raw)) throw new Error("Invalid native Topic event");
        const eventSession=getSessionId(raw);
        if(eventSession && eventSession!==sessionId) throw new Error("Foreign remote session event");
        const targets=[...subscribers.values()].filter(subscriber=>normalizeDirectory(subscriber.directory)===normalized && (!subscriber.sessionId || subscriber.sessionId===sessionId));
        for(const target of targets) {
          if(controller.signal.aborted || generation!==busGeneration || ![...subscribers.values()].includes(target)) break;
          await runInTopicRuntimeContext({...topic,sessionId,directory},async()=>{
            agentArtifactDeliveryService.processEvent(raw as unknown as Event);
            await target.callback(raw as unknown as Event);
          });
        }
      }
    } catch(error) {rejectReady(error); if(!controller.signal.aborted) logger.warn("[TopicEventBus] Remote active stream failed",error);}
    finally {if(!acknowledged)rejectReady(new Error("Remote stream ended before readiness"));clearTimeout(timer);controller.abort();if(remoteRunStreams.get(sessionId)===controller)remoteRunStreams.delete(sessionId);onEnd();}
  })();
  await ready; clearTimeout(timer);
  return ()=>controller.abort();
}

export function hasRemoteTopicRunEvents(sessionId:string):boolean{return remoteRunStreams.has(sessionId);}
