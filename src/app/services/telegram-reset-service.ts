import path from "node:path";
import type { Api } from "grammy";
import { assistantRunState } from "../managers/assistant-run-state-manager.js";
import { promptAttachment } from "../managers/prompt-attachment-manager.js";
import { promptQueue } from "../managers/prompt-queue-manager.js";
import { clearAllInteractionState } from "../managers/interaction-manager.js";
import { detachAttachedSession } from "./attach-service.js";
import { deleteTelegramTopicSession } from "./telegram-topic-delete-service.js";
import { listTelegramTopicBindings, type TelegramTopicBinding } from "./telegram-topic-store.js";
import { getTelegramTopicWorkspaceRoot } from "./telegram-topic-workspace-service.js";
import { clearSessionDirectoryCache, flushSettings, resetGlobalSettingsForFactory } from "../stores/settings-store.js";
import { getRuntimePaths } from "../../runtime/paths.js";
import { clearAllTopicRuntimeStates, removeTopicRuntimeStatesByChat } from "../stores/topic-runtime-state-store.js";
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
    if (assistantRunState.hasActiveRun(binding.sessionId)) throw new Error(`Cannot reset while ${binding.title ?? `session ${binding.sessionId}`} is actively running.`);
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

function clearTransientState(reason: string): void {
  promptQueue.clearAll(reason);
  promptAttachment.clearAll(reason);
  clearAllInteractionState(reason);
  detachAttachedSession(reason);
}

export async function resetHistory(api: Api, chatId: number): Promise<{ deleted: number; failed: number; orphanedWorkspaces: number }> {
  const bindings = (await listTelegramTopicBindings()).filter((binding) => binding.chatId === chatId);
  const result = await deleteBindings(api, bindings);
  const orphanedWorkspaces = await removeOrphanedTopicWorkspaces(chatId);
  await removeTopicRuntimeStatesByChat(chatId);
  clearSessionDirectoryCache();
  clearTransientState("history_reset");
  logger.info(`[TelegramReset] History reset completed: chat=${chatId}, deleted=${result.deleted}, failed=${result.failed}, orphanedWorkspaces=${orphanedWorkspaces}`);
  return { ...result, orphanedWorkspaces };
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
    "providers",
    "integrations",
    path.join(".config", "opencode-telegram"),
  ];
  for (const relativePath of knownPaths) await fs.rm(path.join(appHome, relativePath), { recursive: true, force: true });
  logger.info(`[TelegramReset] Cleared known persisted application state under ${appHome}`);
}

export async function factoryReset(api: Api, chatId: number): Promise<{ deleted: number; failed: number; orphanedWorkspaces: number }> {
  const bindings = await listTelegramTopicBindings();
  const result = await deleteBindings(api, bindings);
  if (result.failed > 0) return { ...result, orphanedWorkspaces: 0 };
  const orphanedWorkspaces = await removeOrphanedTopicWorkspaces();
  await clearAllTopicRuntimeStates();
  clearTransientState("factory_reset");
  await clearFactoryPersistentState();
  resetGlobalSettingsForFactory();
  await flushSettings();
  logger.warn(`[TelegramReset] Factory reset completed globally: requestedChat=${chatId}, deleted=${result.deleted}, failed=${result.failed}, orphanedWorkspaces=${orphanedWorkspaces}`);
  return { ...result, orphanedWorkspaces };
}
