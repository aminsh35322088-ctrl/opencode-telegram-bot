import type { SessionInfo } from "../types/session.js";

let pausedSession: SessionInfo | null = null;

export function setPausedSession(session: SessionInfo): void {
  pausedSession = { ...session };
}

export function getPausedSession(): SessionInfo | null {
  return pausedSession ? { ...pausedSession } : null;
}

export function clearPausedSession(): void {
  pausedSession = null;
}

export function isChatPaused(sessionId?: string): boolean {
  if (!pausedSession) return false;
  return sessionId === undefined || pausedSession.id === sessionId;
}
