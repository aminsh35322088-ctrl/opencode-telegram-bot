import { logger } from "../../utils/logger.js";
import { getCurrentSession } from "../services/session-service.js";

export const MAX_QUEUED_PROMPTS = 5;
export interface QueuedPrompt { id: string; text: string; }

class PromptQueueManager {
  private readonly queues = new Map<string, QueuedPrompt[]>();
  private readonly nextIds = new Map<string, number>();

  private key(sessionId?: string): string { return sessionId ?? getCurrentSession()?.id ?? "__main__"; }
  private items(sessionId?: string): QueuedPrompt[] { const key = this.key(sessionId); let items = this.queues.get(key); if (!items) { items = []; this.queues.set(key, items); } return items; }
  private nextId(sessionId?: string): string { const key = this.key(sessionId); const next = (this.nextIds.get(key) ?? 1); this.nextIds.set(key, next + 1); return `queued-${next}`; }

  add(text: string, sessionId?: string): QueuedPrompt | null {
    const normalizedText = text.trim();
    const items = this.items(sessionId);
    if (!normalizedText || items.length >= MAX_QUEUED_PROMPTS) return null;
    const item = { id: this.nextId(sessionId), text: normalizedText };
    items.push(item);
    logger.debug(`[PromptQueue] Prompt queued: id=${item.id}, session=${this.key(sessionId)}, size=${items.length}`);
    return { ...item };
  }
  list(sessionId?: string): QueuedPrompt[] { return this.items(sessionId).map((item) => ({ ...item })); }
  removeById(id: string, sessionId?: string): QueuedPrompt | null {
    const items = this.items(sessionId); const index = items.findIndex((item) => item.id === id); if (index < 0) return null;
    const [removed] = items.splice(index, 1); if (!removed) return null;
    logger.debug(`[PromptQueue] Prompt removed: id=${removed.id}, session=${this.key(sessionId)}, position=${index + 1}, size=${items.length}`); return { ...removed };
  }
  takeNext(sessionId?: string): QueuedPrompt | null { const item = this.items(sessionId).shift() ?? null; if (item) logger.debug(`[PromptQueue] Prompt taken: id=${item.id}, session=${this.key(sessionId)}`); return item ? { ...item } : null; }
  size(sessionId?: string): number { return this.items(sessionId).length; }
  isFull(sessionId?: string): boolean { return this.items(sessionId).length >= MAX_QUEUED_PROMPTS; }
  clear(reason: string, sessionId?: string): void {
    const key = this.key(sessionId); const items = this.queues.get(key); if (!items || items.length === 0) return;
    logger.info(`[PromptQueue] Cleared queue: reason=${reason}, session=${key}, count=${items.length}`); this.queues.delete(key); this.nextIds.delete(key);
  }
  clearSession(sessionId: string, reason = "session_cleared"): void { this.clear(reason, sessionId); }
  clearAll(reason: string): void { if (this.queues.size === 0) return; logger.info(`[PromptQueue] Cleared all queues: reason=${reason}, sessions=${this.queues.size}`); this.queues.clear(); this.nextIds.clear(); }
  __resetForTests(): void { this.queues.clear(); this.nextIds.clear(); }
}
export const promptQueue = new PromptQueueManager();
