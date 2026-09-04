import type { GroupedPermissionMessage, PermissionRequest, PermissionState } from "../types/permission.js";
import { isPermissionAlwaysAllowed, rememberAlwaysAllowedPermission } from "../stores/settings-store.js";
import { getTopicRuntimeContext } from "../services/topic-runtime-context.js";
import { logger } from "../../utils/logger.js";

interface ScopedPermissionState { state: PermissionState; resolvedRequestIDs: Set<string>; generation: number; }
const emptyState = (): PermissionState => ({ requestsByMessageId: new Map(), requestIdsByMessageId: new Map(), messageIdBySignature: new Map() });
class PermissionManager {
  private readonly scopes = new Map<string, ScopedPermissionState>();
  private key(): string { const topic = getTopicRuntimeContext(); return topic ? `${topic.chatId}:${topic.threadId}` : "__main__"; }
  private scope(): ScopedPermissionState { const key = this.key(); let scope = this.scopes.get(key); if (!scope) { scope = { state: emptyState(), resolvedRequestIDs: new Set(), generation: 0 }; this.scopes.set(key, scope); } return scope; }
  isAlwaysAllowed(chatId: number, request: PermissionRequest): boolean { return isPermissionAlwaysAllowed(chatId, request.permission); }
  rememberAlwaysAllowed(chatId: number, permission: string): Promise<void> { return rememberAlwaysAllowedPermission(chatId, permission); }
  startPermission(request: PermissionRequest, messageId: number, generation = this.scope().generation): boolean { const scope = this.scope(); if (generation !== scope.generation || scope.resolvedRequestIDs.has(request.id)) return false; const previous = scope.state.requestsByMessageId.get(messageId); if (previous) scope.state.messageIdBySignature.delete(this.signature(previous)); scope.state.requestsByMessageId.set(messageId, request); scope.state.requestIdsByMessageId.set(messageId, [request.id]); scope.state.messageIdBySignature.set(this.signature(request), messageId); return true; }
  addEquivalentRequest(request: PermissionRequest, generation = this.scope().generation): GroupedPermissionMessage | null { const scope = this.scope(); if (generation !== scope.generation || scope.resolvedRequestIDs.has(request.id)) return null; const messageId = scope.state.messageIdBySignature.get(this.signature(request)); if (messageId === undefined) return null; const visible = scope.state.requestsByMessageId.get(messageId); if (!visible) return null; const ids = scope.state.requestIdsByMessageId.get(messageId) ?? []; if (!ids.includes(request.id)) ids.push(request.id); scope.state.requestIdsByMessageId.set(messageId, ids); return { messageId, request: visible, count: ids.length }; }
  getRequest(messageId: number | null): PermissionRequest | null { return messageId === null ? null : this.scope().state.requestsByMessageId.get(messageId) ?? null; }
  getRequestID(messageId: number | null): string | null { return this.getRequest(messageId)?.id ?? null; }
  getRequestIDs(messageId: number | null): string[] { return messageId === null ? [] : [...(this.scope().state.requestIdsByMessageId.get(messageId) ?? [])]; }
  getPermissionType(messageId: number | null): string | null { return this.getRequest(messageId)?.permission ?? null; }
  getPatterns(messageId: number | null): string[] { return this.getRequest(messageId)?.patterns ?? []; }
  isActiveMessage(messageId: number | null): boolean { return messageId !== null && this.scope().state.requestsByMessageId.has(messageId); }
  getMessageId(): number | null { const ids = this.getMessageIds(); return ids.length ? ids[ids.length - 1] ?? null : null; }
  getMessageIds(): number[] { return [...this.scope().state.requestsByMessageId.keys()]; }
  removeByMessageId(messageId: number | null): PermissionRequest | null { if (messageId === null) return null; const scope = this.scope(); const request = scope.state.requestsByMessageId.get(messageId); if (!request) return null; scope.state.requestsByMessageId.delete(messageId); scope.state.requestIdsByMessageId.delete(messageId); scope.state.messageIdBySignature.delete(this.signature(request)); return request; }
  resolveRequest(requestID: string): number[] { const scope = this.scope(); scope.resolvedRequestIDs.add(requestID); const removed: number[] = []; for (const [messageId, request] of scope.state.requestsByMessageId) { const ids = scope.state.requestIdsByMessageId.get(messageId) ?? [request.id]; if (!ids.includes(requestID)) continue; scope.state.requestsByMessageId.delete(messageId); scope.state.requestIdsByMessageId.delete(messageId); scope.state.messageIdBySignature.delete(this.signature(request)); removed.push(messageId); } return removed; }
  isResolved(requestID: string): boolean { return this.scope().resolvedRequestIDs.has(requestID); }
  getGeneration(): number { return this.scope().generation; }
  getPendingCount(): number { return this.scope().state.requestsByMessageId.size; }
  isActive(): boolean { return this.getPendingCount() > 0; }
  clear(): void { const scope = this.scope(); logger.debug(`[PermissionManager] Clearing permission state: key=${this.key()}, pending=${scope.state.requestsByMessageId.size}`); scope.state = emptyState(); scope.resolvedRequestIDs.clear(); scope.generation++; }
  clearSession(scopeKey: string): void { this.scopes.delete(scopeKey); }
  clearAll(): void { this.scopes.clear(); }
  private signature(request: PermissionRequest): string { return JSON.stringify({ sessionID: request.sessionID, permission: request.permission, patterns: [...request.patterns].sort() }); }
}
export const permissionManager = new PermissionManager();
