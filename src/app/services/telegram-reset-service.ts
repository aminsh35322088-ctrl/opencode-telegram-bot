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
    if (!entry.isDirectory() || (chatId !== undefined && entry.name !== String(chatId))) continue;
    if (!/^-?\d+$/.test(entry.name)) continue;
    await fs.rm(`${root}/${entry.name}`, { recursive: true, force: true });
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

export async function resetHistory(api: Api, chatId: number): Promise<{ deleted: number; failed: number; orphanedWorkspaces: number }> {
  const bindings = (await listTelegramTopicBindings()).filter((binding) => binding.chatId === chatId);
  const result = await deleteBindings(api, bindings);
  const orphanedWorkspaces = await removeOrphanedTopicWorkspaces(chatId);
  clearSessionDirectoryCache();
  promptQueue.clearAll("history_reset");
  promptAttachment.clearAll("history_reset");
  clearAllInteractionState("history_reset");
  detachAttachedSession("history_reset");
  logger.info(`[TelegramReset] History reset completed: chat=${chatId}, deleted=${result.deleted}, failed=${result.failed}, orphanedWorkspaces=${orphanedWorkspaces}`);
  return { ...result, orphanedWorkspaces };
}

export async function factoryReset(api: Api, chatId: number): Promise<{ deleted: number; failed: number; orphanedWorkspaces: number }> {
  const result = await resetHistory(api, chatId);
  resetGlobalSettingsForFactory();
  await flushSettings();
  logger.warn(`[TelegramReset] Factory reset completed: chat=${chatId}, deleted=${result.deleted}, failed=${result.failed}, orphanedWorkspaces=${result.orphanedWorkspaces}`);
  return result;
}
