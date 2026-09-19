[Reading 137 lines from start (total: 137 lines, 0 remaining)]

import { opencodeClient } from "../../opencode/client.js";
import { markAbortExpected } from "../managers/abort-suppression-manager.js";
import { logger } from "../../utils/logger.js";

const ABORT_TIMEOUT_MS = 4_000;
const IDLE_WAIT_MS = 2_000;
const IDLE_POLL_MS = 100;

export interface SessionErrorRecoveryResult {
  abortAttempted: boolean;
  abortAccepted: boolean;
  unsupportedMime?: string;
  removedMessageIds: string[];
  contaminationRemaining: boolean;
}

type SessionMessageLike = {
  info?: { id?: string; role?: string };
  parts?: Array<{ id?: string; type?: string; mime?: string }>;
};

export function extractUnsupportedFilePartMime(message: string): string | null {
  const match = message.match(/file part media type\s+['"]?([^'"\s]+)['"]?\s+functionality not supported/i);
  return match?.[1]?.trim().toLowerCase() || null;
}

function messageHasMime(message: SessionMessageLike, predicate: (mime: string) => boolean): boolean {
  return (message.parts ?? []).some((part) => part.type === "file" && typeof part.mime === "string" && predicate(part.mime.trim().toLowerCase()));
}

async function loadMessages(sessionId: string, directory: string): Promise<SessionMessageLike[]> {
  const { data, error } = await opencodeClient.session.messages({ sessionID: sessionId, directory });
  if (error) throw error;
  return (data ?? []) as SessionMessageLike[];
}

async function waitUntilNotBusy(sessionId: string, directory: string): Promise<void> {
  const deadline = Date.now() + IDLE_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const { data, error } = await opencodeClient.session.status({ directory });
      if (error || !data) return;
      const status = (data as Record<string, { type?: string }>)[sessionId];
      if (!status || (status.type !== "busy" && status.type !== "retry")) return;
    } catch {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, IDLE_POLL_MS));
  }
}

async function abortSessionBestEffort(sessionId: string, directory: string): Promise<{ attempted: boolean; accepted: boolean }> {
  markAbortExpected(sessionId);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ABORT_TIMEOUT_MS);
  try {
    const { data, error } = await opencodeClient.session.abort({ sessionID: sessionId, directory }, { signal: controller.signal });
    if (error) {
      logger.warn(`[SessionErrorRecovery] Remote abort returned an error: session=${sessionId}`, error);
      return { attempted: true, accepted: false };
    }
    return { attempted: true, accepted: data === true };
  } catch (error) {
    logger.warn(`[SessionErrorRecovery] Remote abort failed: session=${sessionId}`, error);
    return { attempted: true, accepted: false };
  } finally {
    clearTimeout(timeout);
  }
}

async function purgeMessagesByMimePredicate(
  sessionId: string,
  directory: string,
  predicate: (mime: string) => boolean,
  reason: string,
): Promise<{ removedMessageIds: string[]; contaminationRemaining: boolean }> {
  const messages = await loadMessages(sessionId, directory);
  const contaminated = messages.filter((message) => messageHasMime(message, predicate));
  const removedMessageIds: string[] = [];

  for (const message of contaminated) {
    const messageID = message.info?.id;
    if (!messageID) continue;
    const { data, error } = await opencodeClient.session.deleteMessage({ sessionID: sessionId, messageID, directory });
    if (error || data !== true) {
      logger.warn(`[SessionErrorRecovery] Failed to remove contaminated message: session=${sessionId} message=${messageID} reason=${reason}`, error ?? data);
      continue;
    }
    removedMessageIds.push(messageID);
  }

  const verify = await loadMessages(sessionId, directory);
  const contaminationRemaining = verify.some((message) => messageHasMime(message, predicate));
  if (removedMessageIds.length > 0) {
    logger.warn(`[SessionErrorRecovery] Removed incompatible media history: session=${sessionId} messages=${removedMessageIds.join(",")} reason=${reason}`);
  }
  return { removedMessageIds, contaminationRemaining };
}

/**
 * Before text-only STT fallback is sent, remove historical audio FileParts that the
 * current text-only provider would otherwise have to replay. This prevents a previous
 * failed native-audio turn from poisoning every later prompt in the same session.
 */
export async function sanitizeAudioHistoryForTextFallback(sessionId: string, directory: string): Promise<{ removedMessageIds: string[]; contaminationRemaining: boolean }> {
  await waitUntilNotBusy(sessionId, directory);
  return purgeMessagesByMimePredicate(sessionId, directory, (mime) => mime.startsWith("audio/"), "text_stt_fallback");
}

/** Generic session.error recovery: abort the remote run and surgically remove only
 * messages containing the exact unsupported FilePart MIME reported by OpenCode. */
export async function recoverSessionAfterError(sessionId: string, directory: string, message: string): Promise<SessionErrorRecoveryResult> {
  const aborted = await abortSessionBestEffort(sessionId, directory);
  await waitUntilNotBusy(sessionId, directory);

  const unsupportedMime = extractUnsupportedFilePartMime(message) ?? undefined;
  let removedMessageIds: string[] = [];
  let contaminationRemaining = false;
  if (unsupportedMime) {
    try {
      const result = await purgeMessagesByMimePredicate(sessionId, directory, (mime) => mime === unsupportedMime, `session_error:${unsupportedMime}`);
      removedMessageIds = result.removedMessageIds;
      contaminationRemaining = result.contaminationRemaining;
    } catch (error) {
      contaminationRemaining = true;
      logger.error(`[SessionErrorRecovery] Failed to sanitize unsupported media history: session=${sessionId} mime=${unsupportedMime}`, error);
    }
  }

  return {
    abortAttempted: aborted.attempted,
    abortAccepted: aborted.accepted,
    ...(unsupportedMime ? { unsupportedMime } : {}),
    removedMessageIds,
    contaminationRemaining,
  };
}