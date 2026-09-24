import type { Event } from "@opencode-ai/sdk/v2";
import {
  subscribeToTopicEvents,
  stopTopicEventBus,
  stopTopicEventSubscription as stopTopicEventSubscriptionInBus,
  setTopicEventBusIdleTimeoutForTests,
} from "./topic-event-bus.js";
import { getTopicRuntimeContext } from "../app/services/topic-runtime-context.js";
import { findTelegramTopicBindingBySessionId, findTelegramTopicBindingsByDirectory } from "../app/services/telegram-topic-store.js";
import { withTimeout } from "../utils/async-timeout.js";

const INITIAL_SUBSCRIPTION_READY_TIMEOUT_MS = 30_000;

type EventCallback = (event: Event) => void;
const subscriptions = new Map<string, { directory: string; sessionId?: string; callback: EventCallback; stop: () => void }>();

function normalizeDirectory(directory: string): string {
  return directory.replace(/\\/g, "/").replace(/\/+$/u, "").toLowerCase();
}

export async function subscribeToEvents(directory: string, callback: EventCallback, sessionId?: string): Promise<void> {
  const runtimeSessionId = getTopicRuntimeContext()?.sessionId;
  let resolvedSessionId = sessionId ?? runtimeSessionId;
  let resolvedBinding = resolvedSessionId
    ? await findTelegramTopicBindingBySessionId(resolvedSessionId)
    : null;
  if (!resolvedSessionId) {
    const directoryBindingsResult = await findTelegramTopicBindingsByDirectory(directory);
    const directoryBindings = Array.isArray(directoryBindingsResult) ? directoryBindingsResult : [];
    if (directoryBindings.length === 1) {
      resolvedBinding = directoryBindings[0] ?? null;
      resolvedSessionId = resolvedBinding?.sessionId;
    }
  }
  const key = `${normalizeDirectory(directory)}:${resolvedSessionId ?? "*"}:${String(callback)}`;
  subscriptions.get(key)?.stop();
  const stop = subscribeToTopicEvents(
    directory,
    callback,
    resolvedSessionId,
    resolvedBinding ? { chatId: resolvedBinding.chatId, threadId: resolvedBinding.threadId } : undefined,
  );
  subscriptions.set(key, { directory, sessionId: resolvedSessionId, callback, stop });
  try {
    await withTimeout(
      stop.ready,
      INITIAL_SUBSCRIPTION_READY_TIMEOUT_MS,
      `event subscription for ${directory}`,
    );
  } catch (error) {
    stop();
    if (subscriptions.get(key)?.stop === stop) subscriptions.delete(key);
    throw error;
  }
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
