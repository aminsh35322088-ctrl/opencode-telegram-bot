import { logger } from "../../utils/logger.js";
import { getCurrentSession } from "../services/session-service.js";

export interface PendingAttachment { absolutePath: string; worktree: string; confirmationMessageId?: number; }
class PromptAttachmentManager {
  private readonly states = new Map<string, PendingAttachment>();
  private key(sessionId?: string): string { return sessionId ?? getCurrentSession()?.id ?? "__main__"; }
  private state(sessionId?: string): PendingAttachment | undefined { return this.states.get(this.key(sessionId)); }
  set(absolutePath: string, worktree: string, sessionId?: string): void { const key = this.key(sessionId); this.states.set(key, { absolutePath, worktree }); logger.info(`[PromptAttachment] Attached file: session=${key}, path=${absolutePath}, worktree=${worktree}`); }
  setConfirmationMessageId(messageId: number, sessionId?: string): void { const state = this.state(sessionId); if (state) state.confirmationMessageId = messageId; }
  get(sessionId?: string): PendingAttachment | null { const state = this.state(sessionId); return state ? { ...state } : null; }
  clear(reason: string, sessionId?: string): void { const key = this.key(sessionId); const state = this.states.get(key); if (!state) return; logger.info(`[PromptAttachment] Cleared attachment: reason=${reason}, session=${key}, path=${state.absolutePath}`); this.states.delete(key); }
  clearSession(sessionId: string, reason = "session_cleared"): void { this.clear(reason, sessionId); }
  clearAll(reason: string): void { if (this.states.size === 0) return; logger.info(`[PromptAttachment] Cleared all attachments: reason=${reason}, count=${this.states.size}`); this.states.clear(); }
  __resetForTests(): void { this.states.clear(); }
}
export const promptAttachment = new PromptAttachmentManager();
