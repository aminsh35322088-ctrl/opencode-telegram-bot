export type InteractionKind = "permission" | "question";

type PendingState = Map<string, Set<string>>;

/**
 * Tracks server-side interactions that are waiting for user input.
 * Presentation callbacks use this gate so an unresolved permission/question
 * cannot be presented as if the agent were still freely executing.
 */
export class InteractionEventGate {
  private readonly pending: Record<InteractionKind, PendingState> = {
    permission: new Map(),
    question: new Map(),
  };

  mark(kind: InteractionKind, sessionId: string, requestId: string): void {
    if (!sessionId || !requestId) return;
    const requests = this.pending[kind].get(sessionId) ?? new Set<string>();
    requests.add(requestId);
    this.pending[kind].set(sessionId, requests);
  }

  release(kind: InteractionKind, sessionId: string, requestId: string): void {
    const requests = this.pending[kind].get(sessionId);
    if (!requests) return;
    requests.delete(requestId);
    if (requests.size === 0) this.pending[kind].delete(sessionId);
  }

  clearSession(sessionId: string): void {
    this.pending.permission.delete(sessionId);
    this.pending.question.delete(sessionId);
  }

  clear(): void {
    this.pending.permission.clear();
    this.pending.question.clear();
  }

  isBlocked(sessionId: string): boolean {
    return this.isBlockedBy("permission", sessionId) || this.isBlockedBy("question", sessionId);
  }

  isBlockedBy(kind: InteractionKind, sessionId: string): boolean {
    return (this.pending[kind].get(sessionId)?.size ?? 0) > 0;
  }

  getPendingCount(kind: InteractionKind, sessionId?: string): number {
    if (sessionId !== undefined) return this.pending[kind].get(sessionId)?.size ?? 0;
    let total = 0;
    for (const requests of this.pending[kind].values()) total += requests.size;
    return total;
  }
}

export const interactionEventGate = new InteractionEventGate();
