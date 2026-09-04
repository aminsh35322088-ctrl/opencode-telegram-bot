import type { Event } from "@opencode-ai/sdk/v2";
import {
  subscribeToTopicEvents,
  stopTopicEventBus,
  stopTopicEventSubscription as stopTopicEventSubscriptionInBus,
  setTopicEventBusIdleTimeoutForTests,
} from "./topic-event-bus.js";

type EventCallback = (event: Event) => void;
const subscriptions = new Map<string, { directory: string; sessionId?: string; callback: EventCallback; stop: () => void }>();

function normalizeDirectory(directory: string): string {
  return directory.replace(/\\/g, "/").replace(/\/+$/u, "").toLowerCase();
}

export async function subscribeToEvents(directory: string, callback: EventCallback, sessionId?: string): Promise<void> {
  const key = `${normalizeDirectory(directory)}:${sessionId ?? "*"}:${String(callback)}`;
  subscriptions.get(key)?.stop();
  const stop = subscribeToTopicEvents(directory, callback, sessionId);
  subscriptions.set(key, { directory, sessionId, callback, stop });
}

export function stopTopicEventSubscription(directory: string, sessionId?: string): void {
  const normalized = normalizeDirectory(directory);
  for (const [key, subscription] of subscriptions) {
    if (normalizeDirectory(subscription.directory) !== normalized) continue;
    if (sessionId !== undefined && subscription.sessionId !== sessionId) continue;
    subscription.stop();
    subscriptions.delete(key);
  }
  stopTopicEventSubscriptionInBus(directory, sessionId);
}

export function stopEventListening(): void {
  for (const subscription of subscriptions.values()) subscription.stop();
  subscriptions.clear();
  stopTopicEventBus();
}

export function __setSseIdleTimeoutForTests(timeoutMs: number): void {
  setTopicEventBusIdleTimeoutForTests(timeoutMs);
}
