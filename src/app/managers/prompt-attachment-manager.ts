import { logger } from "../../utils/logger.js";
import { getCurrentSession } from "../services/session-service.js";
import { getTopicRuntimeContext } from "../services/topic-runtime-context.js";

export interface PendingAttachment { absolutePath: string; worktree: string; mimeType?: string; confirmationMessageId?: number; }
class PromptAttachmentManager {
  private readonly states = new Map<string, PendingAttachment[]>();
  private key(sessionId?: string): string {
    if (sessionId) return sessionId;
    const topic = getTopicRuntimeContext();
    if (topic?.sessionId) return topic.sessionId;
    return getCurrentSession()?.id ?? "__main__";
  }
  private state(sessionId?: string): PendingAttachment[] | undefined { return this.states.get(this.key(sessionId)); }
  set(absolutePath: string, worktree: string, sessionId?: string, mimeType?: string): void {
    this.setMany([{ absolutePath, worktree, mimeType }], sessionId);
  }
  setMany(attachments: PendingAttachment[], sessionId?: string): void {
    const key = this.key(sessionId);
    const normalized = attachments.map((item) => ({ ...item }));
    if (!normalized.length) { this.states.delete(key); return; }
    this.states.set(key, normalized);
    logger.info(`[PromptAttachment] Attached files: session=${key}, count=${normalized.length}, paths=${normalized.map((item) => item.absolutePath).join(",")}`);
  }
  setConfirmationMessageId(messageId: number, sessionId?: string): void {
    const state = this.state(sessionId); if (state?.[0]) state[0].confirmationMessageId = messageId;
  }
  get(sessionId?: string): PendingAttachment | null { const state = this.state(sessionId)?.[0]; return state ? { ...state } : null; }
  getAll(sessionId?: string): PendingAttachment[] { return (this.state(sessionId) ?? []).map((item) => ({ ...item })); }
  clear(reason: string, sessionId?: string): void {
    const key = this.key(sessionId); const state = this.states.get(key); if (!state?.length) return;
    logger.info(`[PromptAttachment] Cleared attachments: reason=${reason}, session=${key}, count=${state.length}`); this.states.delete(key);
  }
  clearSession(sessionId: string, reason = "session_cleared"): void { this.clear(reason, sessionId); }
  clearAll(reason: string): void { if (this.states.size === 0) return; logger.info(`[PromptAttachment] Cleared all attachments: reason=${reason}, scopes=${this.states.size}`); this.states.clear(); }
  __resetForTests(): void { this.states.clear(); }
}
export const promptAttachment = new PromptAttachmentManager();