import type { Event } from "@opencode-ai/sdk/v2";
import {
  subscribeToTopicEvents,
  stopTopicEventBus,
  stopTopicEventSubscription as stopTopicEventSubscriptionInBus,
  setTopicEventBusIdleTimeoutForTests,
} from "./topic-event-bus.js";
import { getTopicRuntimeContext } from "../app/services/topic-runtime-context.js";
import { findTelegramTopicBindingByDirectory } from "../app/services/telegram-topic-store.js";

type EventCallback = (event: Event) => void;
const subscriptions = new Map<string, { directory: string; sessionId?: string; callback: EventCallback; stop: () => void }>();

function normalizeDirectory(directory: string): string {
  return directory.replace(/\\/g, "/").replace(/\/+$/u, "").toLowerCase();
}

export async function subscribeToEvents(directory: string, callback: EventCallback, sessionId?: string): Promise<void> {
  // Attach/background paths can outlive the AsyncLocalStorage context. Topic
  // workspaces are persisted with a unique session binding, so recover that
  // scope instead of silently installing an unscoped subscriber.
  const runtimeSessionId = getTopicRuntimeContext()?.sessionId;
  const resolvedSessionId = sessionId ?? runtimeSessionId ?? (await findTelegramTopicBindingByDirectory(directory))?.sessionId;
  const key = `${normalizeDirectory(directory)}:${resolvedSessionId ?? "*"}:${String(callback)}`;
  subscriptions.get(key)?.stop();
  const stop = subscribeToTopicEvents(directory, callback, resolvedSessionId);
  subscriptions.set(key, { directory, sessionId: resolvedSessionId, callback, stop });
}

export function stopTopicEventSubscription(directory: string, sessionId?: string): void {
  const resolvedSessionId = sessionId ?? getTopicRuntimeContext()?.sessionId;
  const normalized = normalizeDirectory(directory);
  for (const [key, subscription] of subscriptions) {
    if (normalizeDirectory(subscription.directory) !== normalized) continue;
    if (resolvedSessionId !== undefined && subscription.sessionId !== resolvedSessionId) continue;
    subscription.stop();
    subscriptions.delete(key);
  }
  stopTopicEventSubscriptionInBus(directory, resolvedSessionId);
}

export function stopEventListening(): void {
  for (const subscription of subscriptions.values()) subscription.stop();
  subscriptions.clear();
  stopTopicEventBus();
}

export function __setSseIdleTimeoutForTests(timeoutMs: number): void {
  setTopicEventBusIdleTimeoutForTests(timeoutMs);
}
