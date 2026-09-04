import type { Event } from "@opencode-ai/sdk/v2";
import { subscribeToTopicEvents, stopTopicEventBus, setTopicEventBusIdleTimeoutForTests } from "./topic-event-bus.js";

type EventCallback = (event: Event) => void;
const subscriptions = new Map<string, { directory: string; callback: EventCallback; stop: () => void }>();

export async function subscribeToEvents(directory: string, callback: EventCallback): Promise<void> {
  const key = `${directory}:${String(callback)}`;
  subscriptions.get(key)?.stop();
  const stop = subscribeToTopicEvents(directory, callback);
  subscriptions.set(key, { directory, callback, stop });
}

export function stopEventListening(): void {
  for (const subscription of subscriptions.values()) subscription.stop();
  subscriptions.clear();
  stopTopicEventBus();
}

export function __setSseIdleTimeoutForTests(timeoutMs: number): void {
  setTopicEventBusIdleTimeoutForTests(timeoutMs);
}
