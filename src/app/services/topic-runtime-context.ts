import { AsyncLocalStorage } from "node:async_hooks";
import { topicTelemetry } from "../../utils/topic-observability.js";

export interface TopicRuntimeContext {
  chatId: number;
  threadId: number;
  sessionId?: string;
  directory?: string;
}

const storage = new AsyncLocalStorage<TopicRuntimeContext>();

export function getTopicRuntimeContext(): TopicRuntimeContext | null {
  return storage.getStore() ?? null;
}

/**
 * Stable per-Topic scope key used by topic-scoped managers and wizards.
 * Falls back to `__main__` when no Topic context is active (General/main chat).
 */
export function getTopicScopeKey(): string {
  const topic = storage.getStore();
  return topic ? `${topic.chatId}:${topic.threadId}` : "__main__";
}

export function isTopicRuntimeContextActive(): boolean {
  return storage.getStore() !== undefined;
}

export function runInTopicRuntimeContext<T>(
  context: TopicRuntimeContext,
  callback: () => T,
): T {
  return storage.run({ ...context }, callback);
}

export function withTopicSession<T>(sessionId: string, callback: () => T): T {
  const current = storage.getStore();
  if (!current) return callback();
  const next = { ...current, sessionId };
  topicTelemetry("context_session_bound", next);
  return storage.run(next, callback);
}
