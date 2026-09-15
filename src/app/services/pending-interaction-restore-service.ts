import { opencodeClient } from "../../opencode/client.js";
import { logger } from "../../utils/logger.js";
import type { PermissionRequest } from "../types/permission.js";
import type { Question } from "../types/question.js";
import { listTelegramTopicBindings } from "./telegram-topic-store.js";
import { runInTopicRuntimeContext } from "./topic-runtime-context.js";

export interface PendingInteractionPresenters {
  presentQuestion(sessionId: string, requestID: string, questions: Question[]): Promise<void>;
  presentPermission(request: PermissionRequest): Promise<void>;
}

/**
 * OpenCode keeps question and permission requests pending server-side, but the
 * rendered Telegram polls live only in bot memory. After a bot restart, pending
 * requests would otherwise die as "poll is inactive" taps. This re-presents
 * every pending request for topics that still have bindings, inside the matching
 * Topic runtime context so scoped managers route correctly.
 */
export async function restorePendingInteractions(presenters: PendingInteractionPresenters): Promise<void> {
  let bindings;
  try {
    bindings = await listTelegramTopicBindings();
  } catch (error) {
    logger.warn("[PendingInteractions] Failed to list Topic bindings for restore:", error);
    return;
  }

  let restored = 0;
  for (const binding of bindings) {
    try {
      const [questionsResult, permissionsResult] = await Promise.all([
        opencodeClient.question.list({ directory: binding.directory }),
        opencodeClient.permission.list({ directory: binding.directory }),
      ]);

      if (questionsResult.error) {
        logger.warn(
          `[PendingInteractions] Failed to list pending questions: directory=${binding.directory}`,
          questionsResult.error,
        );
      }

      if (permissionsResult.error) {
        logger.warn(
          `[PendingInteractions] Failed to list pending permissions: directory=${binding.directory}`,
          permissionsResult.error,
        );
      }

      const pendingQuestions = (questionsResult.data ?? []).filter(
        (request) => request.sessionID === binding.sessionId && Array.isArray(request.questions),
      );
      const pendingPermissions = (permissionsResult.data ?? []).filter(
        (request) => request.sessionID === binding.sessionId,
      );

      for (const request of pendingQuestions) {
        logger.info(
          `[PendingInteractions] Restoring pending question: chat=${binding.chatId}, thread=${binding.threadId}, requestID=${request.id}`,
        );
        const questions = request.questions as unknown as Question[];
        await runInTopicRuntimeContext(
          {
            chatId: binding.chatId,
            threadId: binding.threadId,
            sessionId: binding.sessionId,
            directory: binding.directory,
          },
          async () => {
            await presenters.presentQuestion(binding.sessionId, request.id, questions);
          },
        );
        restored += 1;
      }

      for (const request of pendingPermissions) {
        logger.info(
          `[PendingInteractions] Restoring pending permission: chat=${binding.chatId}, thread=${binding.threadId}, requestID=${request.id}`,
        );
        await runInTopicRuntimeContext(
          {
            chatId: binding.chatId,
            threadId: binding.threadId,
            sessionId: binding.sessionId,
            directory: binding.directory,
          },
          async () => {
            await presenters.presentPermission(request as unknown as PermissionRequest);
          },
        );
        restored += 1;
      }
    } catch (error) {
      logger.warn(
        `[PendingInteractions] Restore failed for topic: chat=${binding.chatId}, thread=${binding.threadId}`,
        error,
      );
    }
  }

  if (restored > 0) {
    logger.info(`[PendingInteractions] Re-presented pending interactions after startup: count=${restored}`);
  }
}
