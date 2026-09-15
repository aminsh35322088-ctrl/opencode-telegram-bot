import { opencodeClient } from "../../opencode/client.js";
import { logger } from "../../utils/logger.js";
import type { ModelInfo } from "../types/model.js";
import type { SessionInfo } from "../types/session.js";
import { getTopicRuntimeState, updateTopicRuntimeState } from "../stores/topic-runtime-state-store.js";
import { updateTelegramTopicBinding, type TelegramTopicBinding } from "./telegram-topic-store.js";

interface OpenCodeSessionShape {
  id?: string;
  title?: string;
  directory?: string;
}

export interface TopicSessionRotationResult {
  previousSessionId: string;
  session: SessionInfo;
}

async function deleteReplacementSession(sessionId: string, directory: string): Promise<void> {
  try {
    await opencodeClient.session.delete({ sessionID: sessionId, directory });
  } catch (error) {
    logger.warn(`[TopicSessionRotation] Could not delete orphan replacement session=${sessionId}`, error);
  }
}

/**
 * Creates a fresh OpenCode session for a bound Telegram Topic and moves both
 * persistent Topic stores to it. The old session is deliberately preserved so
 * its history remains available; callers retire only its live runtime/event
 * subscription after this transaction succeeds.
 */
export async function rotateTelegramTopicSessionForModel(
  binding: TelegramTopicBinding,
  model: ModelInfo,
): Promise<TopicSessionRotationResult> {
  if (!model.providerID || !model.modelID) throw new Error("Cannot rotate Topic session without a concrete model");

  const previousRuntimeState = await getTopicRuntimeState(binding.chatId, binding.threadId);
  const createOptions = {
    directory: binding.directory,
    body: { model: { providerID: model.providerID, modelID: model.modelID } },
  } as Parameters<typeof opencodeClient.session.create>[0];
  const { data, error } = await opencodeClient.session.create(createOptions);
  const created = data as OpenCodeSessionShape | undefined;
  if (error || !created?.id) throw error ?? new Error("OpenCode did not return a replacement Topic session");

  const replacement: SessionInfo = {
    id: created.id,
    title: created.title?.trim() || binding.title?.trim() || "Telegram Topic",
    directory: binding.directory,
  };

  let bindingMoved = false;
  try {
    await updateTelegramTopicBinding(binding.chatId, binding.threadId, { sessionId: replacement.id });
    bindingMoved = true;
    await updateTopicRuntimeState(binding.chatId, binding.threadId, {
      session: replacement,
      model,
      runState: "idle",
    });
  } catch (rotationError) {
    if (bindingMoved) {
      await updateTelegramTopicBinding(binding.chatId, binding.threadId, { sessionId: binding.sessionId }).catch((rollbackError) => {
        logger.error(`[TopicSessionRotation] Failed to restore Topic binding after rotation failure: chat=${binding.chatId}, thread=${binding.threadId}`, rollbackError);
      });
    }
    if (previousRuntimeState) {
      await updateTopicRuntimeState(binding.chatId, binding.threadId, previousRuntimeState.settings).catch((rollbackError) => {
        logger.error(`[TopicSessionRotation] Failed to restore Topic runtime state after rotation failure: chat=${binding.chatId}, thread=${binding.threadId}`, rollbackError);
      });
    }
    await deleteReplacementSession(replacement.id, binding.directory);
    throw rotationError;
  }

  logger.info(
    `[TopicSessionRotation] Rotated Topic session: chat=${binding.chatId}, thread=${binding.threadId}, old=${binding.sessionId}, new=${replacement.id}, model=${model.providerID}/${model.modelID}`,
  );
  return { previousSessionId: binding.sessionId, session: replacement };
}
