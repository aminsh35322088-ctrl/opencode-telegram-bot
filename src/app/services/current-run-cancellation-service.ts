import { clearAllInteractionState } from "../managers/interaction-manager.js";
import { foregroundSessionState } from "../managers/foreground-session-state-manager.js";
import { assistantRunState } from "../managers/assistant-run-state-manager.js";
import { markCancellationExpected } from "../managers/cancellation-suppression-manager.js";
import { promptQueue } from "../managers/prompt-queue-manager.js";
import { promptAttachment } from "../managers/prompt-attachment-manager.js";
import { getEffectiveCurrentSession } from "./session-service.js";
import { markAttachedSessionIdle } from "./attach-service.js";
import { stopSessionStallWatchdog } from "./session-stall-watchdog.js";
import { getTopicRuntimeContext } from "./topic-runtime-context.js";
import { updateTopicRuntimeStateSync } from "../stores/topic-runtime-state-store.js";
import { opencodeClient } from "../../opencode/client.js";
import { logger } from "../../utils/logger.js";

export type CancelCurrentRunResult =
  | "confirmed"
  | "unconfirmed"
  | "maybe-finished"
  | "timeout"
  | "error"
  | "no-session";

export interface CancelCurrentRunOptions {
  sessionId?: string;
  directory?: string;
  reason: string;
  timeoutMs?: number;
}

type SessionState = "idle" | "busy" | "retry" | "not-found";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function resolveTarget(options: CancelCurrentRunOptions): Promise<{ id: string; directory: string } | null> {
  if (options.sessionId !== undefined || options.directory !== undefined) {
    if (!options.sessionId || !options.directory) throw new Error("cancellation_identity_incomplete");
    return { id: options.sessionId, directory: options.directory };
  }
  const current = await getEffectiveCurrentSession();
  return current ? { id: current.id, directory: current.directory } : null;
}

async function pollSessionStatus(
  sessionId: string,
  directory: string,
  maxWaitMs: number,
): Promise<SessionState> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    try {
      const { data, error } = await opencodeClient.session.status({ directory });
      if (error || !data) break;
      const state = (data as Record<string, { type?: string }>)[sessionId];
      if (!state) return "not-found";
      if (state.type === "idle" || state.type === "error") return "idle";
      if (state.type !== "busy" && state.type !== "retry") return "not-found";
      await sleep(250);
    } catch (error) {
      logger.warn("[Cancellation] Failed to poll session status:", error);
      break;
    }
  }
  return "busy";
}

async function releaseLocalRunState(sessionId: string, reason: string): Promise<void> {
  stopSessionStallWatchdog(sessionId);
  foregroundSessionState.markIdle(sessionId);
  assistantRunState.clearRun(sessionId, reason);
  promptQueue.clear(reason, sessionId);
  promptAttachment.clear(reason, sessionId);
  await markAttachedSessionIdle(sessionId);
  const topic = getTopicRuntimeContext();
  if (topic?.sessionId === sessionId) {
    updateTopicRuntimeStateSync(topic.chatId, topic.threadId, { runState: "idle" });
  }
}

/**
 * Internal run cancellation primitive. It deliberately renders no Telegram UI;
 * Telegram Native Stop and destructive lifecycle handlers own user presentation.
 */
export async function cancelCurrentRun(
  options: CancelCurrentRunOptions,
): Promise<CancelCurrentRunResult> {
  try {
    const target = await resolveTarget(options);
    if (!target) return "no-session";

    clearAllInteractionState(options.reason);
    promptQueue.clear(options.reason, target.id);
    promptAttachment.clear(options.reason, target.id);
    markCancellationExpected(target.id);

    const timeoutMs = Math.max(250, Math.min(options.timeoutMs ?? 5_000, 30_000));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      logger.info(`[Cancellation] Requesting current-run cancellation: session=${target.id}, reason=${options.reason}`);
      const { data, error } = await opencodeClient.session.abort(
        { sessionID: target.id, directory: target.directory },
        { signal: controller.signal },
      );
      clearTimeout(timeout);
      if (error) {
        logger.warn(`[Cancellation] Remote cancellation was not confirmed: session=${target.id}`, error);
        return "unconfirmed";
      }
      if (data !== true) {
        const state = await pollSessionStatus(target.id, target.directory, Math.min(1_500, timeoutMs));
        if (state === "busy" || state === "retry") return "unconfirmed";
        await releaseLocalRunState(target.id, `${options.reason}_maybe_finished`);
        return "maybe-finished";
      }
      const state = await pollSessionStatus(target.id, target.directory, timeoutMs);
      if (state === "idle" || state === "not-found") {
        await releaseLocalRunState(target.id, `${options.reason}_confirmed`);
        return "confirmed";
      }
      return "unconfirmed";
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof Error && error.name === "AbortError") {
        logger.warn(`[Cancellation] Remote cancellation timed out: session=${target.id}`);
        return "timeout";
      }
      logger.error(`[Cancellation] Remote cancellation failed: session=${target.id}`, error);
      return "error";
    }
  } catch (error) {
    logger.error("[Cancellation] Failed before cancellation could be admitted:", error);
    return "error";
  }
}
