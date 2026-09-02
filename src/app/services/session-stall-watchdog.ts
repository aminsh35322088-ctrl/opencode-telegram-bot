import { opencodeClient } from "../../opencode/client.js";
import { foregroundSessionState } from "../managers/foreground-session-state-manager.js";
import { assistantRunState } from "../managers/assistant-run-state-manager.js";
import { markAttachedSessionIdle } from "./attach-service.js";
import { logger } from "../../utils/logger.js";

const POLL_INTERVAL_MS = 5000;
const STALL_AFTER_MS = 4 * 60 * 1000;
const ABORT_REQUEST_TIMEOUT_MS = 5000;
const ABORT_CONFIRMATION_TIMEOUT_MS = 8000;
const MESSAGE_LIMIT = 6;

type SessionStatus = { type?: string };

const activeWatchdogs = new Map<string, AbortController>();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function hasRunningToolPart(messages: unknown[]): boolean {
  return messages.some((message) => {
    const record = asRecord(message);
    const parts = record?.parts;
    if (!Array.isArray(parts)) return false;
    return parts.some((part) => {
      const partRecord = asRecord(part);
      const state = asRecord(partRecord?.state);
      return state?.status === "running";
    });
  });
}

function buildMeaningfulFingerprint(messages: unknown[]): string {
  const recent = messages.slice(-2).map((message) => {
    const record = asRecord(message);
    const info = asRecord(record?.info);
    const time = asRecord(info?.time);
    const parts = Array.isArray(record?.parts)
      ? record.parts.map((part) => {
          const partRecord = asRecord(part);
          const state = asRecord(partRecord?.state);
          return {
            id: partRecord?.id,
            type: partRecord?.type,
            textLength: typeof partRecord?.text === "string" ? partRecord.text.length : undefined,
            stateStatus: typeof state?.status === "string" ? state.status : undefined,
            title: typeof state?.title === "string" ? state.title : undefined,
          };
        })
      : [];

    return {
      messageId: typeof info?.id === "string" ? info.id : undefined,
      role: typeof info?.role === "string" ? info.role : undefined,
      created: time?.created,
      updated: time?.updated,
      completed: time?.completed,
      parts,
    };
  });

  return JSON.stringify(recent);
}

async function getMessages(sessionId: string, directory: string): Promise<unknown[] | null> {
  try {
    const { data, error } = await opencodeClient.session.messages({ sessionID: sessionId, directory, limit: MESSAGE_LIMIT });
    if (error || !Array.isArray(data)) return null;
    return data as unknown[];
  } catch (error) {
    logger.debug(`[StallWatchdog] Message probe failed: session=${sessionId}`, error);
    return null;
  }
}

async function getStatus(sessionId: string, directory: string): Promise<SessionStatus | null> {
  try {
    const { data, error } = await opencodeClient.session.status({ directory });
    if (error || !data) return null;
    return ((data as Record<string, SessionStatus>)[sessionId] ?? null) as SessionStatus | null;
  } catch (error) {
    logger.debug(`[StallWatchdog] Status probe failed: session=${sessionId}`, error);
    return null;
  }
}

async function requestAbort(sessionId: string, directory: string): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ABORT_REQUEST_TIMEOUT_MS);
  try {
    const { data, error } = await opencodeClient.session.abort({ sessionID, directory }, { signal: controller.signal });
    logger.warn(`[StallWatchdog] Abort result: session=${sessionId}, result=${String(data)}, error=${error ? "yes" : "no"}`);
    return !error && data === true;
  } catch (error) {
    logger.warn(`[StallWatchdog] Abort request failed: session=${sessionId}`, error);
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function waitForIdle(sessionId: string, directory: string): Promise<boolean> {
  const deadline = Date.now() + ABORT_CONFIRMATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await getStatus(sessionId, directory);
    if (!status || status.type === "idle" || status.type === "error") return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

async function clearLocalRunState(sessionId: string, reason: string): Promise<void> {
  foregroundSessionState.markIdle(sessionId);
  assistantRunState.clearRun(sessionId, reason);
  await markAttachedSessionIdle(sessionId);
}

export function startSessionStallWatchdog(options: { sessionId: string; directory: string; model: string }): void {
  if (activeWatchdogs.has(options.sessionId)) return;

  const controller = new AbortController();
  activeWatchdogs.set(options.sessionId, controller);

  void (async () => {
    let lastFingerprint = "";
    let lastMeaningfulProgressAt = Date.now();
    logger.debug(`[StallWatchdog] Started: session=${options.sessionId}, model=${options.model}, stallAfterMs=${STALL_AFTER_MS}`);

    try {
      while (!controller.signal.aborted) {
        await sleep(POLL_INTERVAL_MS);
        if (controller.signal.aborted) return;

        const status = await getStatus(options.sessionId, options.directory);
        if (!status || status.type === "idle" || status.type === "error") return;
        if (status.type !== "busy" && status.type !== "retry") continue;

        const messages = await getMessages(options.sessionId, options.directory);
        if (!messages) continue;

        // A running tool is genuine work. Do not kill long installs, builds, tests,
        // or other commands merely because they produce no new assistant text.
        if (hasRunningToolPart(messages)) {
          lastMeaningfulProgressAt = Date.now();
          continue;
        }

        const fingerprint = buildMeaningfulFingerprint(messages);
        if (fingerprint !== lastFingerprint) {
          lastFingerprint = fingerprint;
          lastMeaningfulProgressAt = Date.now();
          continue;
        }

        const stalledForMs = Date.now() - lastMeaningfulProgressAt;
        if (stalledForMs < STALL_AFTER_MS) continue;

        logger.warn(`[StallWatchdog] Session stalled: session=${options.sessionId}, model=${options.model}, stalledForMs=${stalledForMs}, status=${status.type}. Requesting abort.`);
        const aborted = await requestAbort(options.sessionId, options.directory);
        if (!aborted) {
          logger.error(`[StallWatchdog] Could not confirm abort request: session=${options.sessionId}; preserving local busy state.`);
          lastMeaningfulProgressAt = Date.now();
          continue;
        }

        const idle = await waitForIdle(options.sessionId, options.directory);
        if (!idle) {
          logger.error(`[StallWatchdog] Abort acknowledged but session did not become idle: session=${options.sessionId}; preserving local busy state.`);
          lastMeaningfulProgressAt = Date.now();
          continue;
        }

        await clearLocalRunState(options.sessionId, "stall_watchdog_abort_confirmed");
        logger.warn(`[StallWatchdog] Recovered stalled session: session=${options.sessionId}, model=${options.model}`);
        return;
      }
    } catch (error) {
      logger.error(`[StallWatchdog] Unexpected watchdog failure: session=${options.sessionId}`, error);
    } finally {
      activeWatchdogs.delete(options.sessionId);
    }
  })();
}

export function stopSessionStallWatchdog(sessionId: string): void {
  const controller = activeWatchdogs.get(sessionId);
  if (!controller) return;
  controller.abort();
  activeWatchdogs.delete(sessionId);
}

export function __resetSessionStallWatchdogsForTests(): void {
  for (const controller of activeWatchdogs.values()) controller.abort();
  activeWatchdogs.clear();
}
