import { flushAppState } from "../stores/app-state-store.js";
import type { Api } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { assistantRunState } from "../managers/assistant-run-state-manager.js";
import { promptAttachment } from "../managers/prompt-attachment-manager.js";
import { promptQueue } from "../managers/prompt-queue-manager.js";
import { clearAllInteractionState } from "../managers/interaction-manager.js";
import { detachAttachedSession } from "./attach-service.js";
import { deleteTelegramTopicSession } from "./telegram-topic-delete-service.js";
import { listTelegramTopicBindings, type TelegramTopicBinding } from "./telegram-topic-store.js";
import { getTelegramTopicWorkspaceRoot, reconcileTopicWorkspaces } from "./telegram-topic-workspace-service.js";
import { clearAllMemories, listMemories } from "./memory-service.js";
import { clearSessionDirectoryCache, flushSettings, resetGlobalSettingsForFactory } from "../stores/settings-store.js";
import { clearAllTopicRuntimeStates, listTopicRuntimeStates } from "../stores/topic-runtime-state-store.js";
import { getPersistentStatePaths } from "./persistent-state-registry.js";
import { logger } from "../../utils/logger.js";

// Binding-aware sweep: workspace directories of still-bound topics are kept,
// everything unreferenced (failed/aborted/interrupted deletes) is removed.
// Runs unconditionally, because gating it on "no delete failed" leaked orphan
// workspaces forever whenever a single delete errored.
async function removeOrphanedTopicWorkspaces(): Promise<number> {
  try {
    const bindings = await listTelegramTopicBindings();
    const referenced = new Set(bindings.map((binding) => binding.directory));
    const removed = await reconcileTopicWorkspaces(referenced);
    return removed.length;
  } catch (error) {
    logger.error("[TelegramReset] Failed to reconcile orphaned topic workspaces", error);
    return 0;
  }
}
async function deleteBindings(api: Api, bindings: TelegramTopicBinding[]): Promise<{ deleted: number; failed: number }> {
  let deleted = 0; let failed = 0;
  for (const binding of bindings) {
    if (assistantRunState.hasActiveRun(binding.sessionId)) { logger.error(`[TelegramReset] Skipping active Topic during reset: chat=${binding.chatId}, thread=${binding.threadId}, session=${binding.sessionId}`); failed += 1; continue; }
    try { await deleteTelegramTopicSession(api, binding); deleted += 1; logger.info(`[TelegramReset] Topic removed: chat=${binding.chatId}, thread=${binding.threadId}, session=${binding.sessionId}`); }
    catch (error) { failed += 1; logger.error(`[TelegramReset] Failed to remove Topic during reset: chat=${binding.chatId}, thread=${binding.threadId}, session=${binding.sessionId}`, error); }
  }
  return { deleted, failed };
}
async function verifyManagedSessionsDeleted(bindings: TelegramTopicBinding[]): Promise<number> { let remaining = 0; for (const binding of bindings) { try { const { data } = await opencodeClient.session.get({ sessionID: binding.sessionId, directory: binding.directory }); if (data) remaining += 1; } catch { /* missing/deleted session */ } } return remaining; }
async function countManagedTopicWorkspaces(): Promise<number> { const fs = await import("fs/promises"); const root = getTelegramTopicWorkspaceRoot(); try { const entries = await fs.readdir(root, { withFileTypes: true }); return entries.filter((entry) => entry.isDirectory() && /^-?\d+$/.test(entry.name)).length; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; } }
async function verifyLocalHistoryState(): Promise<{ bindings: number; runtimeStates: number; memories: number; workspaces: number }> { const [bindings, runtimeStates, memories] = await Promise.all([listTelegramTopicBindings(), listTopicRuntimeStates(), listMemories()]); return { bindings: bindings.length, runtimeStates: runtimeStates.length, memories: memories.length, workspaces: await countManagedTopicWorkspaces() }; }
function clearTransientState(reason: string): void { promptQueue.clearAll(reason); promptAttachment.clearAll(reason); clearAllInteractionState(reason); detachAttachedSession(reason); }

export async function resetHistory(api: Api, _chatId: number): Promise<{ deleted: number; failed: number; orphanedWorkspaces: number; memoriesCleared: number }> {
  const bindings = await listTelegramTopicBindings(); const result = await deleteBindings(api, bindings); const orphanedWorkspaces = await removeOrphanedTopicWorkspaces(); await clearAllTopicRuntimeStates(); clearSessionDirectoryCache(); clearTransientState("history_reset"); const memoriesCleared = await clearAllMemories();
  if (result.failed > 0) return { ...result, orphanedWorkspaces, memoriesCleared };
  const remainingSessions = await verifyManagedSessionsDeleted(bindings); const state = await verifyLocalHistoryState();
  if (remainingSessions > 0 || state.bindings > 0 || state.runtimeStates > 0 || state.memories > 0 || state.workspaces > 0) { logger.error(`[TelegramReset] History reset verification FAILED: remainingSessions=${remainingSessions}, bindings=${state.bindings}, runtimeStates=${state.runtimeStates}, memories=${state.memories}, workspaces=${state.workspaces}`); return { deleted: result.deleted, failed: 1, orphanedWorkspaces, memoriesCleared }; }
  logger.info(`[TelegramReset] History reset VERIFIED: deleted=${result.deleted}, sessions=0, bindings=0, runtimeStates=0, memories=0, workspaces=0, orphanedWorkspaces=${orphanedWorkspaces}`); return { ...result, orphanedWorkspaces, memoriesCleared };
}
async function clearFactoryPersistentState(): Promise<void> { await flushAppState(); const fs = await import("fs/promises"); for (const statePath of getPersistentStatePaths()) await fs.rm(statePath, { recursive: true, force: true }); delete process.env.GITHUB_TOKEN; logger.info(`[TelegramReset] Cleared registered Bot persistent state and Model Center preferences`); }
export async function factoryReset(api: Api, chatId: number): Promise<{ deleted: number; failed: number; orphanedWorkspaces: number; memoriesCleared: number }> {
  const bindings = await listTelegramTopicBindings(); const result = await deleteBindings(api, bindings);
  const orphanedWorkspacesAtAbort = await removeOrphanedTopicWorkspaces();
  if (result.failed > 0) { logger.error(`[TelegramReset] Factory reset aborted before config purge: deleted=${result.deleted}, failed=${result.failed}, total=${bindings.length}, orphanedWorkspaces=${orphanedWorkspacesAtAbort}`); return { ...result, orphanedWorkspaces: orphanedWorkspacesAtAbort, memoriesCleared: 0 }; }
  if (await verifyManagedSessionsDeleted(bindings) > 0) { logger.error(`[TelegramReset] Factory reset stopped before clearing persistent state: remainingManagedSessions>0`); return { deleted: result.deleted, failed: 1, orphanedWorkspaces: 0, memoriesCleared: 0 }; }
  const memoriesCleared = (await listMemories()).length; const orphanedWorkspaces = orphanedWorkspacesAtAbort + (await removeOrphanedTopicWorkspaces()); await clearAllTopicRuntimeStates(); clearTransientState("factory_reset"); await clearFactoryPersistentState(); resetGlobalSettingsForFactory(); await flushSettings();
  const state = await verifyLocalHistoryState();
  if (state.bindings > 0 || state.runtimeStates > 0 || state.memories > 0 || state.workspaces > 0) { logger.error(`[TelegramReset] Factory reset verification FAILED: bindings=${state.bindings}, runtimeStates=${state.runtimeStates}, memories=${state.memories}, workspaces=${state.workspaces}`); return { deleted: result.deleted, failed: 1, orphanedWorkspaces, memoriesCleared }; }
  logger.warn(`[TelegramReset] Factory reset VERIFIED globally: requestedChat=${chatId}, deleted=${result.deleted}/${bindings.length}, bindings=0, runtimeStates=0, memories=0, workspaces=0, orphanedWorkspaces=${orphanedWorkspaces}, memoriesCleared=${memoriesCleared}, settings=fresh, modelCenter=fresh`); return { ...result, orphanedWorkspaces, memoriesCleared };
}
