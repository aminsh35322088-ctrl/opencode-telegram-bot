// Covers abort request timeout, post-abort status polling, and delayed SSE reconnect delivery.
const USER_ABORT_SUPPRESSION_WINDOW_MS = 90_000;

const userAbortRequestedAtBySession = new Map<string, number>();

function deleteExpiredAbortRequests(now: number = Date.now()): void {
  for (const [sessionId, requestedAt] of userAbortRequestedAtBySession) {
    if (now - requestedAt > USER_ABORT_SUPPRESSION_WINDOW_MS) {
      userAbortRequestedAtBySession.delete(sessionId);
    }
  }
}

/**
 * Registers that the next "Aborted" session.error for this session is an
 * expected consequence of an abort the bot itself initiated (user /abort,
 * stall watchdog recovery, scheduled-task cleanup, Image AI takeover, or the
 * deterministic provider-retry policy) and must not be surfaced as a raw
 * 🔴 error in the middle of the conversation.
 */
export function markAbortExpected(sessionId: string): void {
  const now = Date.now();
  deleteExpiredAbortRequests(now);
  userAbortRequestedAtBySession.set(sessionId, now);
}

export function markUserAbortRequested(sessionId: string): void {
  markAbortExpected(sessionId);
}

export function shouldSuppressUserAbortSessionError(sessionId: string, message: string): boolean {
  if (message.trim().toLowerCase() !== "aborted") {
    return false;
  }

  const requestedAt = userAbortRequestedAtBySession.get(sessionId);
  if (requestedAt === undefined) {
    return false;
  }

  userAbortRequestedAtBySession.delete(sessionId);
  return Date.now() - requestedAt <= USER_ABORT_SUPPRESSION_WINDOW_MS;
}

export function __resetUserAbortErrorSuppressionForTests(): void {
  userAbortRequestedAtBySession.clear();
}

export function __getUserAbortErrorSuppressionSizeForTests(): number {
  return userAbortRequestedAtBySession.size;
}
