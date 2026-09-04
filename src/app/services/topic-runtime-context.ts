import { AsyncLocalStorage } from "node:async_hooks";
import { topicTelemetry } from "../../utils/topic-observability.js";

export interface TopicRuntimeContext {
  chatId: number;
  threadId: number;
  sessionId?: string;
}

const storage = new AsyncLocalStorage<TopicRuntimeContext>();

export function getTopicRuntimeContext(): TopicRuntimeContext | null {
  return storage.getStore() ?? null;
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
