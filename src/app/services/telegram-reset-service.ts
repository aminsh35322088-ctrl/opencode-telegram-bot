import path from "node:path";
import type { Api } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { assistantRunState } from "../managers/assistant-run-state-manager.js";
import { promptAttachment } from "../managers/prompt-attachment-manager.js";
import { promptQueue } from "../managers/prompt-queue-manager.js";
import { clearAllInteractionState } from "../managers/interaction-manager.js";
import { detachAttachedSession } from "./attach-service.js";
import { deleteTelegramTopicSession } from "./telegram-topic-delete-service.js";
import { listTelegramTopicBindings, type TelegramTopicBinding } from "./telegram-topic-store.js";
import { getTelegramTopicWorkspaceRoot } from "./telegram-topic-workspace-service.js";
import { clearAllMemories, listMemories } from "./memory-service.js";
import { clearSessionDirectoryCache, flushSettings, resetGlobalSettingsForFactory } from "../stores/settings-store.js";
import { getRuntimePaths } from "../../runtime/paths.js";
import { clearAllTopicRuntimeStates, listTopicRuntimeStates } from "../stores/topic-runtime-state-store.js";
import { logger } from "../../utils/logger.js";

async function removeOrphanedTopicWorkspaces(chatId?: number): Promise<number> {
  const fs = await import("fs/promises");
  const root = getTelegramTopicWorkspaceRoot();
  let removed = 0;
  let entries: import("fs").Dirent[] = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || (chatId !== undefined && entry.name !== String(chatId)) || !/^-?\d+$/.test(entry.name)) continue;
    await fs.rm(path.join(root, entry.name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

async function deleteBindings(api: Api, bindings: TelegramTopicBinding[]): Promise<{ deleted: number; failed: number }> {
  let deleted = 0;
  let failed = 0;

  for (const binding of bindings) {
    if (assistantRunState.hasActiveRun(binding.sessionId)) {
      throw new Error(`Cannot reset while ${binding.title ?? `session ${binding.sessionId}`} is actively running.`);
    }

    try {
      await deleteTelegramTopicSession(api, binding);
      deleted += 1;
    } catch (error) {
      failed += 1;
      logger.error(`[TelegramReset] Failed to remove Topic during reset: chat=${binding.chatId}, thread=${binding.threadId}, session=${binding.sessionId}`, error);
    }
  }

  return { deleted, failed };
}

async function verifyManagedSessionsDeleted(bindings: TelegramTopicBinding[]): Promise<number> {
  let remaining = 0;
  for (const binding of bindings) {
    try {
      const { data } = await opencodeClient.session.get({ sessionID: binding.sessionId, directory: binding.directory });
      if (data) {
        remaining += 1;
        logger.error(`[TelegramReset] Verification found a managed OpenCode session still present: session=${binding.sessionId}, directory=${binding.directory}`);
      }
    } catch {
      // OpenCode reports a missing/deleted session through the error channel.
    }
  }
  return remaining;
}

async function countManagedTopicWorkspaces(): Promise<number> {
  const fs = await import("fs/promises");
  const root = getTelegramTopicWorkspaceRoot();
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && /^-?\d+$/.test(entry.name)).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function verifyLocalHistoryState(): Promise<{ bindings: number; runtimeStates: number; memories: number; workspaces: number }> {
  const [bindings, runtimeStates, memories] = await Promise.all([
    listTelegramTopicBindings(),
    listTopicRuntimeStates(),
    listMemories(),
  ]);
  const workspaces = await countManagedTopicWorkspaces();
  return { bindings: bindings.length, runtimeStates: runtimeStates.length, memories: memories.length, workspaces };
}

function clearTransientState(reason: string): void {
  promptQueue.clearAll(reason);
  promptAttachment.clearAll(reason);
  clearAllInteractionState(reason);
  detachAttachedSession(reason);
}

export async function resetHistory(api: Api, _chatId: number): Promise<{ deleted: number; failed: number; orphanedWorkspaces: number; memoriesCleared: number }> {
  // History is the managed application history, so the destructive reset is
  // global across all managed Topics rather than limited to whichever chat
  // happened to open Settings.
  const bindings = await listTelegramTopicBindings();
  const result = await deleteBindings(api, bindings);
  const orphanedWorkspaces = result.failed === 0 ? await removeOrphanedTopicWorkspaces() : 0;
  await clearAllTopicRuntimeStates();
  clearSessionDirectoryCache();
  clearTransientState("history_reset");
  const memoriesCleared = await clearAllMemories();

  if (result.failed > 0) {
    logger.warn(`[TelegramReset] History reset completed with cleanup failures: deleted=${result.deleted}, failed=${result.failed}, orphanedWorkspaces=${orphanedWorkspaces}, memoriesCleared=${memoriesCleared}`);
    return { ...result, orphanedWorkspaces, memoriesCleared };
  }

  const remainingSessions = await verifyManagedSessionsDeleted(bindings);
  const state = await verifyLocalHistoryState();
  if (remainingSessions > 0 || state.bindings > 0 || state.runtimeStates > 0 || state.memories > 0 || state.workspaces > 0) {
    logger.error(`[TelegramReset] History reset verification FAILED: remainingSessions=${remainingSessions}, bindings=${state.bindings}, runtimeStates=${state.runtimeStates}, memories=${state.memories}, workspaces=${state.workspaces}`);
    return { deleted: result.deleted, failed: 1, orphanedWorkspaces, memoriesCleared };
  }

  logger.info(`[TelegramReset] History reset VERIFIED: deleted=${result.deleted}, sessions=0, bindings=0, runtimeStates=0, memories=0, workspaces=0, orphanedWorkspaces=${orphanedWorkspaces}`);
  return { ...result, orphanedWorkspaces, memoriesCleared };
}

async function clearFactoryPersistentState(): Promise<void> {
  const fs = await import("fs/promises");
  const appHome = getRuntimePaths().appHome;
  const knownPaths = [
    "custom-providers.json",
    "settings.json",
    "settings.json.bak",
    "settings.json.tmp",
    "telegram-topic-bindings.json",
    "telegram-topic-bindings.json.bak",
    "telegram-topic-runtime.json",
    "telegram-topic-runtime.json.tmp",
    "memory.json",
    "memory.json.tmp",
    "providers",
    "integrations",
    path.join(".config", "opencode-telegram"),
  ];
  for (const relativePath of knownPaths) await fs.rm(path.join(appHome, relativePath), { recursive: true, force: true });
  delete process.env.GITHUB_TOKEN;
  logger.info(`[TelegramReset] Cleared known persisted application state under ${appHome}`);
}

export async function factoryReset(api: Api, chatId: number): Promise<{ deleted: number; failed: number; orphanedWorkspaces: number; memoriesCleared: number }> {
  const bindings = await listTelegramTopicBindings();
  const result = await deleteBindings(api, bindings);
  if (result.failed > 0) return { ...result, orphanedWorkspaces: 0, memoriesCleared: 0 };

  const remainingSessions = await verifyManagedSessionsDeleted(bindings);
  if (remainingSessions > 0) {
    logger.error(`[TelegramReset] Factory reset stopped before clearing persistent state: remainingManagedSessions=${remainingSessions}`);
    return { deleted: result.deleted, failed: 1, orphanedWorkspaces: 0, memoriesCleared: 0 };
  }

  const memoriesCleared = (await listMemories()).length;
  const orphanedWorkspaces = await removeOrphanedTopicWorkspaces();
  await clearAllTopicRuntimeStates();
  clearTransientState("factory_reset");
  await clearFactoryPersistentState();
  resetGlobalSettingsForFactory();
  await flushSettings();

  const state = await verifyLocalHistoryState();
  if (state.bindings > 0 || state.runtimeStates > 0 || state.memories > 0 || state.workspaces > 0) {
    logger.error(`[TelegramReset] Factory reset verification FAILED: bindings=${state.bindings}, runtimeStates=${state.runtimeStates}, memories=${state.memories}, workspaces=${state.workspaces}`);
    return { deleted: result.deleted, failed: 1, orphanedWorkspaces, memoriesCleared };
  }

  logger.warn(`[TelegramReset] Factory reset VERIFIED globally: requestedChat=${chatId}, deleted=${result.deleted}, bindings=0, runtimeStates=0, memories=0, workspaces=0 (${orphanedWorkspaces} root(s) removed), memoriesCleared=${memoriesCleared}, settings=fresh`);
  return { ...result, orphanedWorkspaces, memoriesCleared };
}
