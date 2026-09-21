import { flushAppState } from "../stores/app-state-store.js";
import type { Api } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { assistantRunState } from "../managers/assistant-run-state-manager.js";
import { promptAttachment } from "../managers/prompt-attachment-manager.js";
import { promptQueue } from "../managers/prompt-queue-manager.js";
import { clearAllInteractionState } from "../managers/interaction-manager.js";
import { detachAttachedSession } from "./attach-service.js";
import { deleteTelegramTopicSession, isOpencodeSessionNotFoundError } from "./telegram-topic-delete-service.js";
import { listTelegramTopicBindings, type TelegramTopicBinding } from "./telegram-topic-store.js";
import { getTelegramTopicWorkspaceRoots, reconcileTopicWorkspaces } from "./telegram-topic-workspace-service.js";
import { clearAllMemories, listMemories } from "./memory-service.js";
import { clearSessionDirectoryCache, flushSettings, resetGlobalSettingsForFactory } from "../stores/settings-store.js";
import { clearAllTopicRuntimeStates, listTopicRuntimeStates } from "../stores/topic-runtime-state-store.js";
import { getPersistentStatePaths } from "./persistent-state-registry.js";
import { scheduledTaskRuntime } from "./scheduled-task-runtime-service.js";
import { foregroundSessionState } from "../managers/foreground-session-state-manager.js";
import { rustDeskSecureInputManager } from "../managers/rustdesk-secure-input-manager.js";
import { clearAllToolActivity } from "../managers/tool-activity-manager.js";
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
function findActiveBindings(bindings: TelegramTopicBinding[]): TelegramTopicBinding[] {
  return bindings.filter((binding) => assistantRunState.hasActiveRun(binding.sessionId));
}

async function deleteBindings(api: Api, bindings: TelegramTopicBinding[]): Promise<{ deleted: number; failed: number }> {
  const activeBindings = findActiveBindings(bindings);
  if (activeBindings.length > 0) {
    for (const binding of activeBindings) {
      logger.error(
        `[TelegramReset] Reset preflight blocked by active Topic: chat=${binding.chatId}, thread=${binding.threadId}, session=${binding.sessionId}`,
      );
    }
    return { deleted: 0, failed: activeBindings.length };
  }

  let deleted = 0;
  let failed = 0;
  for (const binding of bindings) {
    if (assistantRunState.hasActiveRun(binding.sessionId)) {
      logger.error(
        `[TelegramReset] Topic became active during reset; stopping further deletion: chat=${binding.chatId}, thread=${binding.threadId}, session=${binding.sessionId}`,
      );
      failed += 1;
      break;
    }
    try {
      await deleteTelegramTopicSession(api, binding);
      deleted += 1;
      logger.info(
        `[TelegramReset] Topic removed: chat=${binding.chatId}, thread=${binding.threadId}, session=${binding.sessionId}`,
      );
    } catch (error) {
      failed += 1;
      logger.error(
        `[TelegramReset] Failed to remove Topic during reset: chat=${binding.chatId}, thread=${binding.threadId}, session=${binding.sessionId}`,
        error,
      );
      break;
    }
  }
  return { deleted, failed };
}
async function verifyManagedSessionsDeleted(bindings: TelegramTopicBinding[]): Promise<number> {
  let remaining = 0;
  for (const binding of bindings) {
    try {
      const { data, error } = await opencodeClient.session.get({
        sessionID: binding.sessionId,
        directory: binding.directory,
      });
      if (error) {
        if (isOpencodeSessionNotFoundError(error)) continue;
        remaining += 1;
        logger.error(
          `[TelegramReset] Could not verify session deletion; treating session as remaining: session=${binding.sessionId}`,
          error,
        );
        continue;
      }
      if (data) {
        remaining += 1;
        continue;
      }
      remaining += 1;
      logger.error(
        `[TelegramReset] Session deletion verification returned no data and no not-found error: session=${binding.sessionId}`,
      );
    } catch (error) {
      if (isOpencodeSessionNotFoundError(error)) continue;
      remaining += 1;
      logger.error(
        `[TelegramReset] Session deletion verification threw; treating session as remaining: session=${binding.sessionId}`,
        error,
      );
    }
  }
  return remaining;
}
async function countManagedTopicWorkspaces(): Promise<number> {
  const fs = await import("fs/promises");
  let total = 0;
  for (const root of getTelegramTopicWorkspaceRoots()) {
    try {
      const chatEntries = await fs.readdir(root, { withFileTypes: true });
      for (const chatEntry of chatEntries) {
        if (!chatEntry.isDirectory() || !/^-?\d+$/.test(chatEntry.name)) continue;
        const chatDir = (await import("node:path")).join(root, chatEntry.name);
        const sessionEntries = await fs.readdir(chatDir, { withFileTypes: true });
        total += sessionEntries.filter((entry) => entry.isDirectory()).length;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return total;
}
async function verifyLocalHistoryState(): Promise<{ bindings: number; runtimeStates: number; memories: number; workspaces: number }> { const [bindings, runtimeStates, memories] = await Promise.all([listTelegramTopicBindings(), listTopicRuntimeStates(), listMemories()]); return { bindings: bindings.length, runtimeStates: runtimeStates.length, memories: memories.length, workspaces: await countManagedTopicWorkspaces() }; }
function clearTransientState(reason: string): void {
  promptQueue.clearAll(reason);
  promptAttachment.clearAll(reason);
  clearAllInteractionState(reason);
  detachAttachedSession(reason);
  assistantRunState.clearAll(reason);
  foregroundSessionState.clearAll(reason);
  rustDeskSecureInputManager.clearAll();
  clearAllToolActivity();
}

export async function resetHistory(api: Api, _chatId: number): Promise<{ deleted: number; failed: number; orphanedWorkspaces: number; memoriesCleared: number }> {
  const bindings = await listTelegramTopicBindings();
  const result = await deleteBindings(api, bindings);

  if (result.failed > 0) {
    logger.error(
      `[TelegramReset] History reset stopped before global state cleanup: deleted=${result.deleted}, failed=${result.failed}, total=${bindings.length}`,
    );
    return { ...result, orphanedWorkspaces: 0, memoriesCleared: 0 };
  }

  const orphanedWorkspaces = await removeOrphanedTopicWorkspaces();
  const remainingSessions = await verifyManagedSessionsDeleted(bindings);
  if (remainingSessions > 0) {
    logger.error(
      `[TelegramReset] History reset stopped before global state cleanup: remainingManagedSessions=${remainingSessions}`,
    );
    return { deleted: result.deleted, failed: 1, orphanedWorkspaces, memoriesCleared: 0 };
  }

  await clearAllTopicRuntimeStates();
  clearSessionDirectoryCache();
  await flushSettings();
  clearTransientState("history_reset");
  const memoriesCleared = await clearAllMemories();

  const state = await verifyLocalHistoryState();
  if (state.bindings > 0 || state.runtimeStates > 0 || state.memories > 0 || state.workspaces > 0) {
    logger.error(
      `[TelegramReset] History reset verification FAILED: bindings=${state.bindings}, runtimeStates=${state.runtimeStates}, memories=${state.memories}, workspaces=${state.workspaces}`,
    );
    return { deleted: result.deleted, failed: 1, orphanedWorkspaces, memoriesCleared };
  }
  logger.info(
    `[TelegramReset] History reset VERIFIED: deleted=${result.deleted}, sessions=0, bindings=0, runtimeStates=0, memories=0, workspaces=0, orphanedWorkspaces=${orphanedWorkspaces}`,
  );
  return { ...result, orphanedWorkspaces, memoriesCleared };
}
async function clearFactoryPersistentState(): Promise<void> {
  await flushAppState();
  const fs = await import("fs/promises");
  for (const statePath of getPersistentStatePaths()) {
    await fs.rm(statePath, { recursive: true, force: true });
  }
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.RAILWAY_TOKEN;
  delete process.env.RAILWAY_API_TOKEN;
  logger.info("[TelegramReset] Cleared registered Bot persistent state, integrations, and Model Center preferences");
}
export async function factoryReset(api: Api, chatId: number): Promise<{ deleted: number; failed: number; orphanedWorkspaces: number; memoriesCleared: number }> {
  const bindings = await listTelegramTopicBindings();

  if (scheduledTaskRuntime.hasRunningTasks()) {
    logger.error("[TelegramReset] Factory reset preflight blocked by a running scheduled task");
    return { deleted: 0, failed: 1, orphanedWorkspaces: 0, memoriesCleared: 0 };
  }

  const result = await deleteBindings(api, bindings);
  if (result.failed > 0) {
    logger.error(
      `[TelegramReset] Factory reset aborted before config purge: deleted=${result.deleted}, failed=${result.failed}, total=${bindings.length}`,
    );
    return { ...result, orphanedWorkspaces: 0, memoriesCleared: 0 };
  }

  const orphanedWorkspacesAtAbort = await removeOrphanedTopicWorkspaces();
  if (await verifyManagedSessionsDeleted(bindings) > 0) {
    logger.error("[TelegramReset] Factory reset stopped before clearing persistent state: remainingManagedSessions>0");
    return { deleted: result.deleted, failed: 1, orphanedWorkspaces: orphanedWorkspacesAtAbort, memoriesCleared: 0 };
  }

  if (scheduledTaskRuntime.hasRunningTasks()) {
    logger.error("[TelegramReset] Factory reset stopped before config purge because a scheduled task started during Topic cleanup");
    return { deleted: result.deleted, failed: 1, orphanedWorkspaces: orphanedWorkspacesAtAbort, memoriesCleared: 0 };
  }

  const memoriesCleared = (await listMemories()).length;
  const orphanedWorkspaces = orphanedWorkspacesAtAbort + (await removeOrphanedTopicWorkspaces());

  if (!scheduledTaskRuntime.clearAll("factory_reset")) {
    logger.error("[TelegramReset] Factory reset stopped before persistent-state purge because scheduled runtime could not be cleared");
    return { deleted: result.deleted, failed: 1, orphanedWorkspaces, memoriesCleared: 0 };
  }

  await clearAllTopicRuntimeStates();
  clearTransientState("factory_reset");
  await clearFactoryPersistentState();
  resetGlobalSettingsForFactory();
  await flushSettings();

  const state = await verifyLocalHistoryState();
  if (state.bindings > 0 || state.runtimeStates > 0 || state.memories > 0 || state.workspaces > 0) {
    logger.error(
      `[TelegramReset] Factory reset verification FAILED: bindings=${state.bindings}, runtimeStates=${state.runtimeStates}, memories=${state.memories}, workspaces=${state.workspaces}`,
    );
    return { deleted: result.deleted, failed: 1, orphanedWorkspaces, memoriesCleared };
  }

  logger.warn(
    `[TelegramReset] Factory reset VERIFIED globally: requestedChat=${chatId}, deleted=${result.deleted}/${bindings.length}, bindings=0, runtimeStates=0, memories=0, workspaces=0, orphanedWorkspaces=${orphanedWorkspaces}, memoriesCleared=${memoriesCleared}, settings=fresh, modelCenter=fresh`,
  );
  return { ...result, orphanedWorkspaces, memoriesCleared };
}
