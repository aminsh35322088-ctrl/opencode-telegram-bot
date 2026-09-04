import type { InteractionClearReason, InteractionState, StartInteractionOptions, TransitionInteractionOptions } from "../types/interaction.js";
import { permissionManager } from "./permission-manager.js";
import { questionManager } from "./question-manager.js";
import { renameManager } from "./rename-manager.js";
import { taskCreationManager } from "./scheduled-task-creation-manager.js";
import { logger } from "../../utils/logger.js";
import { getTopicRuntimeContext } from "../services/topic-runtime-context.js";

export const DEFAULT_ALLOWED_INTERACTION_COMMANDS = ["/help", "/status", "/abort", "/detach", "/opencode_stop"] as const;
const DEFAULT_INLINE_MENU_TTL_MS = 15 * 60 * 1000;
function normalizeCommand(command: string): string | null { const trimmed = command.trim().toLowerCase(); if (!trimmed) return null; const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`; const withoutMention = withSlash.split("@")[0]; return withoutMention.length > 1 ? withoutMention : null; }
function normalizeAllowedCommands(commands?: string[]): string[] { if (commands === undefined) return [...DEFAULT_ALLOWED_INTERACTION_COMMANDS]; const normalized = new Set<string>(); for (const command of commands) { const value = normalizeCommand(command); if (value) normalized.add(value); } return [...normalized]; }
function cloneState(state: InteractionState): InteractionState { return { ...state, allowedCommands: [...state.allowedCommands], metadata: { ...state.metadata } }; }

class InteractionManager {
  private readonly states = new Map<string, InteractionState>();
  private key(): string { const topic = getTopicRuntimeContext(); return topic ? `${topic.chatId}:${topic.threadId}` : "__main__"; }
  private current(): InteractionState | null { return this.states.get(this.key()) ?? null; }
  private set(state: InteractionState): void { this.states.set(this.key(), state); }

  start(options: StartInteractionOptions): InteractionState {
    const now = Date.now();
    const existing = this.current();
    if (existing) this.clear("state_replaced");
    const expiresAt = typeof options.expiresInMs === "number" ? now + options.expiresInMs : options.kind === "inline" ? now + DEFAULT_INLINE_MENU_TTL_MS : null;
    const nextState: InteractionState = { kind: options.kind, expectedInput: options.expectedInput, allowedCommands: normalizeAllowedCommands(options.allowedCommands), metadata: options.metadata ? { ...options.metadata } : {}, createdAt: now, expiresAt };
    this.set(nextState);
    logger.info(`[InteractionManager] Started interaction: key=${this.key()}, kind=${nextState.kind}, expectedInput=${nextState.expectedInput}`);
    return cloneState(nextState);
  }
  get(): InteractionState | null { const state = this.current(); return state ? cloneState(state) : null; }
  getSnapshot(): InteractionState | null { return this.get(); }
  isActive(): boolean { return this.current() !== null; }
  isExpired(referenceTimeMs = Date.now()): boolean { const state = this.current(); return !!state && state.expiresAt !== null && referenceTimeMs >= state.expiresAt; }
  transition(options: TransitionInteractionOptions): InteractionState | null {
    const state = this.current(); if (!state) return null; const now = Date.now();
    const next: InteractionState = { ...state, kind: options.kind ?? state.kind, expectedInput: options.expectedInput ?? state.expectedInput, allowedCommands: options.allowedCommands !== undefined ? normalizeAllowedCommands(options.allowedCommands) : [...state.allowedCommands], metadata: options.metadata ? { ...options.metadata } : { ...state.metadata }, expiresAt: options.expiresInMs === undefined ? state.expiresAt : options.expiresInMs === null ? null : now + options.expiresInMs };
    this.set(next); return cloneState(next);
  }
  clear(reason: InteractionClearReason = "manual"): void { const state = this.current(); if (!state) return; logger.info(`[InteractionManager] Cleared interaction: key=${this.key()}, reason=${reason}, kind=${state.kind}`); this.states.delete(this.key()); }
  clearSession(sessionKey: string): void { this.states.delete(sessionKey); }
  clearAll(reason: string): void { if (this.states.size > 0) logger.info(`[InteractionManager] Cleared all interactions: count=${this.states.size}, reason=${reason}`); this.states.clear(); }
}
export const interactionManager = new InteractionManager();

export type InteractionErrorScope = "question" | "permission" | "rename" | "taskCreation" | "interaction" | "none";
const SCOPE_TO_INTERACTION_KIND: Record<Exclude<InteractionErrorScope, "interaction" | "none">, InteractionState["kind"]> = { question: "question", permission: "permission", rename: "rename", taskCreation: "task" };
export function clearInteractionErrorState(scope: InteractionErrorScope, reason: string): void {
  if (scope === "none") return;
  const stateBefore = interactionManager.getSnapshot();
  if (scope === "interaction") { interactionManager.clear(reason); return; }
  if (scope === "question") questionManager.clear(); else if (scope === "permission") permissionManager.clear(); else if (scope === "rename") renameManager.clear(); else taskCreationManager.clear();
  if (stateBefore?.kind === SCOPE_TO_INTERACTION_KIND[scope]) interactionManager.clear(reason);
}
export function clearAllInteractionState(reason: string): void {
  const topic = getTopicRuntimeContext();
  if (topic) {
    questionManager.clear(); permissionManager.clear(); renameManager.clear(); taskCreationManager.clear(); interactionManager.clear(reason); return;
  }
  questionManager.clear(); permissionManager.clear(); renameManager.clear(); taskCreationManager.clear(); interactionManager.clearAll(reason);
}
