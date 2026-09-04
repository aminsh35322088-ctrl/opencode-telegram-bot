import type { SessionInfo } from "../types/session.js";

const pausedSessions = new Map<string, SessionInfo>();

export function setPausedSession(session: SessionInfo): void {
  if (!session.id) return;
  pausedSessions.set(session.id, { ...session });
}

export function getPausedSession(sessionId?: string): SessionInfo | null {
  if (sessionId !== undefined) {
    const session = pausedSessions.get(sessionId);
    return session ? { ...session } : null;
  }

  const first = pausedSessions.values().next().value as SessionInfo | undefined;
  return first ? { ...first } : null;
}

export function clearPausedSession(sessionId?: string): void {
  if (sessionId === undefined) {
    pausedSessions.clear();
    return;
  }
  pausedSessions.delete(sessionId);
}

export function isChatPaused(sessionId?: string): boolean {
  if (sessionId !== undefined) return pausedSessions.has(sessionId);
  return pausedSessions.size > 0;
}

export function getPausedSessionIds(): string[] {
  return [...pausedSessions.keys()];
}

export function clearAllPausedSessions(): void {
  pausedSessions.clear();
}
