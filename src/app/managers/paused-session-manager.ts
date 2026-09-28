import { getTopicRuntimeContext } from "../services/topic-runtime-context.js";
import { updateTopicRuntimeStateSync } from "../stores/topic-runtime-state-store.js";
import type { SessionInfo } from "../types/session.js";

export interface PausedSubagentRef {
  sessionId: string;
  title?: string;
  agent?: string;
}

const pausedSessions = new Map<string, SessionInfo>();
const pausedSubagents = new Map<string, PausedSubagentRef[]>();

function scopedSessionId(sessionId?: string): string | undefined { return sessionId ?? getTopicRuntimeContext()?.sessionId; }
function updateScopedRunState(runState: "idle" | "running" | "paused" | "aborting"): void {
  const context = getTopicRuntimeContext();
  if (!context) return;
  updateTopicRuntimeStateSync(context.chatId, context.threadId, { runState });
}

export function setPausedSession(session: SessionInfo): void {
  if (!session.id) return;
  pausedSessions.set(session.id, { ...session });
  updateScopedRunState("paused");
}

export function getPausedSession(sessionId?: string): SessionInfo | null {
  const scopedId = scopedSessionId(sessionId);
  if (scopedId !== undefined) {
    const session = pausedSessions.get(scopedId);
    return session ? { ...session } : null;
  }
  const first = pausedSessions.values().next().value as SessionInfo | undefined;
  return first ? { ...first } : null;
}

export function setPausedSubagents(
  parentSessionId: string,
  subagents: PausedSubagentRef[],
): void {
  if (!parentSessionId) return;
  const unique = new Map<string, PausedSubagentRef>();
  for (const subagent of subagents) {
    if (!subagent.sessionId) continue;
    unique.set(subagent.sessionId, { ...subagent });
  }
  pausedSubagents.set(parentSessionId, Array.from(unique.values()));
}

export function getPausedSubagents(parentSessionId?: string): PausedSubagentRef[] {
  const scopedId = scopedSessionId(parentSessionId);
  if (!scopedId) return [];
  return (pausedSubagents.get(scopedId) ?? []).map((subagent) => ({ ...subagent }));
}

export function clearPausedSession(sessionId?: string): void {
  const scopedId = scopedSessionId(sessionId);
  if (scopedId !== undefined) {
    pausedSessions.delete(scopedId);
    pausedSubagents.delete(scopedId);
    updateScopedRunState("idle");
    return;
  }
  pausedSessions.clear();
  pausedSubagents.clear();
}

export function isChatPaused(sessionId?: string): boolean {
  const scopedId = scopedSessionId(sessionId);
  if (scopedId !== undefined) return pausedSessions.has(scopedId);
  return pausedSessions.size > 0;
}
