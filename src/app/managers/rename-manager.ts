import { logger } from "../../utils/logger.js";
import { getTopicRuntimeContext } from "../services/topic-runtime-context.js";

interface RenameState { isWaiting: boolean; sessionId: string | null; sessionDirectory: string | null; currentTitle: string | null; messageId: number | null; }
const emptyState = (): RenameState => ({ isWaiting: false, sessionId: null, sessionDirectory: null, currentTitle: null, messageId: null });
class RenameManager {
  private readonly states = new Map<string, RenameState>();
  private key(): string { const topic = getTopicRuntimeContext(); return topic ? `${topic.chatId}:${topic.threadId}` : "__main__"; }
  private state(): RenameState { const key = this.key(); let state = this.states.get(key); if (!state) { state = emptyState(); this.states.set(key, state); } return state; }
  startWaiting(sessionId: string, directory: string, currentTitle: string): void { this.states.set(this.key(), { isWaiting: true, sessionId, sessionDirectory: directory, currentTitle, messageId: null }); logger.info(`[RenameManager] Starting rename flow: key=${this.key()}, session=${sessionId}`); }
  setMessageId(messageId: number): void { this.state().messageId = messageId; }
  getMessageId(): number | null { return this.state().messageId; }
  isActiveMessage(messageId: number | null): boolean { const state = this.state(); return state.isWaiting && state.messageId !== null && state.messageId === messageId; }
  isWaitingForName(): boolean { return this.state().isWaiting; }
  getSessionInfo(): { sessionId: string; directory: string; currentTitle: string } | null { const state = this.state(); if (!state.isWaiting || !state.sessionId || !state.sessionDirectory || !state.currentTitle) return null; return { sessionId: state.sessionId, directory: state.sessionDirectory, currentTitle: state.currentTitle }; }
  clear(): void { this.states.set(this.key(), emptyState()); }
  clearSession(scopeKey: string): void { this.states.delete(scopeKey); }
  clearAll(): void { this.states.clear(); }
}
export const renameManager = new RenameManager();
