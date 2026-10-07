import {deleteForumTopicWithRetry} from "./telegram-forum-delete.js";
import { nodeBindings } from "../../control-plane/node-bindings.js";
import { topicNodeLifecycle } from "../../control-plane/topic-node-lifecycle.js";
import path from "node:path";
import type { Api } from "grammy";
import type { BindingIdentity } from "@opencode-telegram/native-runtime";
import { opencodeClient } from "../../opencode/client.js";
import { clearSession, getCurrentSession } from "./session-service.js";
import { detachAttachedSession } from "./attach-service.js";
import { removeTelegramTopicBinding, listTelegramTopicBindings, findTelegramTopicBindingByThread, type TelegramTopicBinding } from "./telegram-topic-store.js";
import { deleteTelegramTopicWorkspace, isTelegramTopicWorkspace } from "./telegram-topic-workspace-service.js";
import { removeTopicRuntimeState } from "../stores/topic-runtime-state-store.js";
import { promptQueue } from "../managers/prompt-queue-manager.js";
import { promptAttachment } from "../managers/prompt-attachment-manager.js";
import { interactionManager } from "../managers/interaction-manager.js";
import { questionManager } from "../managers/question-manager.js";
import { permissionManager } from "../managers/permission-manager.js";
import { renameManager } from "../managers/rename-manager.js";
import { taskCreationManager } from "../managers/scheduled-task-creation-manager.js";
import { summaryAggregator } from "../managers/summary-aggregation-manager.js";
import { dropTopicScopedInstance } from "./topic-scoped-singleton.js";
import { keyboardManager } from "../../bot/keyboards/keyboard-manager.js";
import { stopTopicEventSubscription } from "../../opencode/events.js";
import { clearQueuedPromptContext } from "../../bot/handlers/prompt-queue-dispatch.js";
import { logger } from "../../utils/logger.js";
import { topicTelemetry } from "../../utils/topic-observability.js";
import { getTelegramTopicRuntimeDependencies } from "../../bot/services/telegram-topic-runtime.js";
import { coreBindingId, finishCoreRunForSession, getNativeCore, registerCoreTopicBinding } from "../../core/native-core-service.js";

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const candidate = error as {
      message?: unknown;
      name?: unknown;
      _tag?: unknown;
      status?: unknown;
      statusCode?: unknown;
      data?: { message?: unknown; name?: unknown; _tag?: unknown; status?: unknown };
      response?: { status?: unknown };
    };
    const message = candidate.message ?? candidate.data?.message;
    if (typeof message === "string" && message.trim()) return message;
    try { return JSON.stringify(error); } catch { /* fall through */ }
  }
  return String(error);
}

export function isOpencodeSessionNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return /session.*not found|not found.*session/i.test(errorMessage(error));
  const candidate = error as {
    name?: unknown;
    _tag?: unknown;
    status?: unknown;
    statusCode?: unknown;
    data?: { message?: unknown; name?: unknown; _tag?: unknown; status?: unknown };
    response?: { status?: unknown };
  };
  const status = candidate.status ?? candidate.statusCode ?? candidate.data?.status ?? candidate.response?.status;
  if (status === 404) return true;
  const descriptor = [
    candidate.name,
    candidate._tag,
    candidate.data?.name,
    candidate.data?._tag,
    errorMessage(error),
  ].filter((value): value is string => typeof value === "string").join(" ");
  return /NotFoundError|SessionNotFound|session.*not found|not found.*session/i.test(descriptor);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorMessage(error));
}

async function cleanupTelegramTopicSessionMetadata(api: Api, binding: TelegramTopicBinding): Promise<void> {
  const context = { chatId: binding.chatId, threadId: binding.threadId, sessionId: binding.sessionId, directory: binding.directory };
  topicTelemetry("delete_started", context);
  const cleanupErrors: Error[] = [];

  // The unmanaged-directory guard only protects the filesystem rm step. Binding,
  // runtime-state, session, and keyboard cleanup must always run, or a Topic
  // with a stale directory permanently refuses deletion and leaks workspace
  // state files on the volume.
  const managedWorkspace = isTelegramTopicWorkspace(binding.directory);
  if (!managedWorkspace) {
    topicTelemetry("delete_refused_unmanaged_workspace", context);
    logger.warn(`[TelegramTopics] Topic directory is not a managed workspace; skipping directory deletion: chat=${binding.chatId}, thread=${binding.threadId}, directory=${binding.directory}`);
    cleanupErrors.push(new Error(`Refused to delete unmanaged directory: ${binding.directory}`));
  }

  const remoteNode = (await nodeBindings.list()).find(node => node.chatId === binding.chatId && node.threadId === binding.threadId && node.sessionId === binding.sessionId);
  try {
    if(remoteNode) {
      if(remoteNode.status!=="retired")await topicNodeLifecycle.retire(binding.chatId,binding.threadId);
      topicTelemetry("remote_node_retired",context);
    } else {
    const { data, error } = await opencodeClient.session.delete({ sessionID: binding.sessionId, directory: binding.directory });
    if (error) {
      if (isOpencodeSessionNotFoundError(error)) {
        logger.info(`[TelegramTopics] OpenCode session already absent: session=${binding.sessionId}`);
        topicTelemetry("session_already_deleted", context);
      } else {
        throw asError(error);
      }
    } else if (data !== true) {
      throw new Error(`OpenCode did not confirm deletion of session ${binding.sessionId}`);
    } else {
      topicTelemetry("session_deleted", context);
    }
    }
  } catch (error) {
    if (isOpencodeSessionNotFoundError(error)) {
      logger.info(`[TelegramTopics] OpenCode session already absent: session=${binding.sessionId}`);
      topicTelemetry("session_already_deleted", context);
    } else {
      const normalized = asError(error);
      cleanupErrors.push(normalized);
      logger.warn(`[TelegramTopics] Session cleanup failed; retaining Topic binding for retry: session=${binding.sessionId}`, error);
      topicTelemetry("session_delete_failed_binding_retained", context);
      throw new AggregateError(
        cleanupErrors,
        `Telegram Topic ${binding.threadId} cleanup stopped because OpenCode session deletion was not confirmed; binding retained for retry.`,
      );
    }
  }

  stopTopicEventSubscription(binding.directory, binding.sessionId);
  getTelegramTopicRuntimeDependencies()?.retireSessionRuntime(binding.sessionId, "topic_deleted");
  topicTelemetry("event_subscription_removed", context);

  if (getCurrentSession()?.id === binding.sessionId) {
    clearSession();
    detachAttachedSession("telegram_topic_deleted");
  }

  if (managedWorkspace) {
    try {
      await deleteTelegramTopicWorkspace(binding.directory);
      topicTelemetry("workspace_deleted", context);
    } catch (error) {
      cleanupErrors.push(asError(error));
      logger.error(`[TelegramTopics] Failed to delete managed Topic workspace; retaining Topic binding for retry: directory=${binding.directory}`, error);
      topicTelemetry("workspace_delete_failed_binding_retained", context);
      throw new AggregateError(
        cleanupErrors,
        `Telegram Topic ${binding.threadId} cleanup stopped because workspace deletion failed; binding retained for retry.`,
      );
    }
  }

  try {
    await deleteForumTopicWithRetry(api, binding.chatId, binding.threadId);
    topicTelemetry("telegram_topic_deleted", context);
  } catch (error) {
    cleanupErrors.push(asError(error));
    logger.warn(`[TelegramTopics] Telegram Topic delete failed; retaining binding for retry: chat=${binding.chatId}, thread=${binding.threadId}`, error);
    topicTelemetry("telegram_topic_delete_failed_binding_retained", context);
    throw new AggregateError(
      cleanupErrors,
      `Telegram Topic ${binding.threadId} cleanup stopped because Telegram deletion failed; binding retained for retry.`,
    );
  }

  promptQueue.clearSession(binding.sessionId, "telegram_topic_deleted");
  clearQueuedPromptContext(binding.sessionId);
  promptAttachment.clearSession(binding.sessionId, "telegram_topic_deleted");
  keyboardManager.clearSession(binding.sessionId);
  const topicScopeKey = `${binding.chatId}:${binding.threadId}`;
  interactionManager.clearSession(topicScopeKey);
  questionManager.clearSession(topicScopeKey);
  permissionManager.clearSession(topicScopeKey);
  renameManager.clearSession(topicScopeKey);
  taskCreationManager.clearSession(topicScopeKey);
  dropTopicScopedInstance(summaryAggregator, topicScopeKey);
  topicTelemetry("ephemeral_state_cleared", context);

  try {
    await removeTopicRuntimeState(binding.chatId, binding.threadId);
    topicTelemetry("runtime_state_removed", context);
  } catch (error) {
    cleanupErrors.push(asError(error));
    logger.error(`[TelegramTopics] Failed to remove Topic runtime state; retaining binding for retry: chat=${binding.chatId}, thread=${binding.threadId}`, error);
    throw new AggregateError(
      cleanupErrors,
      `Telegram Topic ${binding.threadId} cleanup stopped because runtime-state removal failed; binding retained for retry.`,
    );
  }

  try {
    await removeTelegramTopicBinding(binding.chatId, binding.sessionId);
    topicTelemetry("binding_removed", context);
  } catch (error) {
    cleanupErrors.push(asError(error));
    logger.error(`[TelegramTopics] Failed to remove Topic binding: chat=${binding.chatId}, session=${binding.sessionId}`, error);
  }

  const remainingBindings = (await listTelegramTopicBindings()).filter((b) => b.chatId === binding.chatId);
  if (remainingBindings.length === 0) {
    logger.info(`[TelegramTopics] No topics remaining for chat=${binding.chatId}; returning to normal mode`);
    keyboardManager.initialize(api, binding.chatId);
    await keyboardManager.sendKeyboardUpdate(binding.chatId, true).catch((err) => {
      logger.warn("[TelegramTopics] Failed to send main keyboard after returning to normal mode:", err);
    });
  }

  if (cleanupErrors.length > 0) {
    topicTelemetry("delete_completed_with_cleanup_errors", context, { cleanupErrors: cleanupErrors.length });
    throw new AggregateError(cleanupErrors, `Telegram Topic ${binding.threadId} was deleted, but ${cleanupErrors.length} local cleanup step(s) failed.`);
  }

  topicTelemetry("delete_completed", context);
  logger.info(`[TelegramTopics] Permanently deleted Topic: session=${binding.sessionId}, chat=${binding.chatId}, thread=${binding.threadId}, directory=${binding.directory}`);
}


export async function cleanupTelegramTopicBindingResources(
  api: Api,
  identity: BindingIdentity,
): Promise<void> {
  const stored = await findTelegramTopicBindingByThread(identity.chatId, identity.threadId);
  const now = new Date().toISOString();
  await cleanupTelegramTopicSessionMetadata(api, stored ?? {
    chatId: identity.chatId,
    threadId: identity.threadId,
    sessionId: identity.sessionId,
    directory: identity.normalizedDirectory,
    createdAt: now,
    updatedAt: now,
  });
}

export async function deleteTelegramTopicSession(
  api: Api,
  binding: TelegramTopicBinding,
): Promise<void> {
  const node = await nodeBindings.find(binding.chatId,binding.threadId);
  const historical=(await nodeBindings.list()).some(item=>item.chatId===binding.chatId&&item.threadId===binding.threadId&&item.sessionId===binding.sessionId);
  const core = getNativeCore();
  if(node||historical) {
    const bindingId=coreBindingId(binding.chatId,binding.threadId);
    if(core) {
      const active=core.bindings.registry.getById(bindingId);
      const pending=core.bindings.pendingDeletes().find(item=>item.bindingId===bindingId);
      if(active&&(active.sessionId!==binding.sessionId||active.normalizedDirectory!==path.resolve(binding.directory)))throw new Error("Remote deletion Core owner mismatch");
      if(active||pending)await core.bindings.beginDelete(bindingId);
      core.rich.releaseBinding(bindingId);
      finishCoreRunForSession(binding.sessionId);core.runs.fence(bindingId);
    }
    stopTopicEventSubscription(binding.directory,binding.sessionId);
    if(node)await topicNodeLifecycle.retire(binding.chatId,binding.threadId);
    if(core)await core.workers.stop(bindingId,"remote_topic_retired");
    await cleanupTelegramTopicSessionMetadata(api,binding);
    if(core)await core.bindings.completeDelete(bindingId);
    return;
  }
  if (!core) {
    await cleanupTelegramTopicSessionMetadata(api, binding);
    return;
  }
  const bindingId = coreBindingId(binding.chatId, binding.threadId);
  if (!core.bindings.registry.getById(bindingId)) {
    await registerCoreTopicBinding({
      chatId: binding.chatId,
      threadId: binding.threadId,
      sessionId: binding.sessionId,
      directory: binding.directory,
    });
  }
  await core.revokeBinding(bindingId);
}
