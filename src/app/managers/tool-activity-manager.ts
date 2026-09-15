/**
 * Tracks tool calls that are currently running per session.
 *
 * OpenCode only emits `running` tool events when the tool output changes; a
 * blocking tool that prints nothing produces no events, and the stall
 * watchdog's REST polling cannot see the in-flight assistant message. This
 * registry carries the SSE-derived "a tool is live" signal so the watchdog
 * never aborts a session that is busy inside a silent long-running tool.
 */

const STALE_AFTER_MS = 30 * 60_000;

const activeCallsBySession = new Map<string, Map<string, number>>();

export function markToolCallStarted(sessionId: string, callId: string): void {
  if (!sessionId || !callId) {
    return;
  }

  let calls = activeCallsBySession.get(sessionId);
  if (!calls) {
    calls = new Map();
    activeCallsBySession.set(sessionId, calls);
  }

  if (!calls.has(callId)) {
    calls.set(callId, Date.now());
  }
}

export function markToolCallFinished(sessionId: string, callId: string): void {
  const calls = activeCallsBySession.get(sessionId);
  if (!calls) {
    return;
  }

  calls.delete(callId);
  if (calls.size === 0) {
    activeCallsBySession.delete(sessionId);
  }
}

export function hasActiveToolCall(sessionId: string): boolean {
  const calls = activeCallsBySession.get(sessionId);
  if (!calls || calls.size === 0) {
    return false;
  }

  const now = Date.now();
  for (const [callId, startedAt] of calls) {
    if (now - startedAt > STALE_AFTER_MS) {
      calls.delete(callId);
    }
  }

  if (calls.size === 0) {
    activeCallsBySession.delete(sessionId);
    return false;
  }

  return true;
}

export function clearToolActivity(sessionId: string): void {
  activeCallsBySession.delete(sessionId);
}

export function clearAllToolActivity(): void {
  activeCallsBySession.clear();
}

export function __resetToolActivityForTests(): void {
  activeCallsBySession.clear();
}
