import { logger } from "../../utils/logger.js";
import { getTopicRuntimeContext } from "../services/topic-runtime-context.js";

export interface AttachedSessionState { sessionId: string; directory: string; busy: boolean; }

class AttachManager {
  private readonly states = new Map<string, AttachedSessionState>();
  private key(): string { const topic = getTopicRuntimeContext(); return topic ? `${topic.chatId}:${topic.threadId}` : "__main__"; }
  attach(sessionId: string, directory: string): void { if (!sessionId || !directory) return; this.states.set(this.key(), { sessionId, directory, busy: false }); logger.info(`[Attach] Attached to session: key=${this.key()}, session=${sessionId}, directory=${directory}`); }
  clear(reason: string): void { const key = this.key(); const state = this.states.get(key); if (!state) return; logger.info(`[Attach] Cleared attached session: reason=${reason}, key=${key}, session=${state.sessionId}, directory=${state.directory}`); this.states.delete(key); }
  clearSession(sessionId: string, reason = "session_cleared"): void { for (const [key, state] of this.states) if (state.sessionId === sessionId) { logger.info(`[Attach] Cleared attached session: reason=${reason}, key=${key}, session=${sessionId}`); this.states.delete(key); } }
  getSnapshot(): AttachedSessionState | null { const state = this.states.get(this.key()); return state ? { ...state } : null; }
  isAttached(): boolean { return this.states.has(this.key()); }
  isAttachedSession(sessionId: string | null | undefined, directory?: string): boolean { const state = this.states.get(this.key()); if (!state || !sessionId || state.sessionId !== sessionId) return false; return !directory || state.directory === directory; }
  isBusy(): boolean { return this.states.get(this.key())?.busy === true; }
  markBusy(sessionId: string): boolean { const key = this.key(); const state = this.states.get(key); if (!state || state.sessionId !== sessionId || state.busy) return false; state.busy = true; logger.info(`[Attach] Marked attached session busy: key=${key}, session=${sessionId}`); return true; }
  markIdle(sessionId: string): boolean { const key = this.key(); const state = this.states.get(key); if (!state || state.sessionId !== sessionId || !state.busy) return false; state.busy = false; logger.info(`[Attach] Marked attached session idle: key=${key}, session=${sessionId}`); return true; }
  getAllSnapshots(): AttachedSessionState[] { return [...this.states.values()].map((state) => ({ ...state })); }
  __resetForTests(): void { this.states.clear(); }
}
export const attachManager = new AttachManager();
