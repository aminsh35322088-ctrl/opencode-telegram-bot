import { opencodeClient } from "../../opencode/client.js";
import { foregroundSessionState } from "../managers/foreground-session-state-manager.js";
import { assistantRunState } from "../managers/assistant-run-state-manager.js";
import { markAttachedSessionIdle } from "./attach-service.js";
import { logger } from "../../utils/logger.js";
import { markAbortExpected } from "../managers/abort-suppression-manager.js";

const POLL_INTERVAL_MS = 5000;
const STALL_AFTER_MS = 4 * 60 * 1000;
const ABORT_REQUEST_TIMEOUT_MS = 5000;
const ABORT_CONFIRMATION_TIMEOUT_MS = 8000;
const MESSAGE_LIMIT = 6;

type SessionStatus = { type?: string };

const activeWatchdogs = new Map<string, AbortController>();
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function hasRunningToolPart(messages: unknown[]): boolean {
  const latest = messages.at(-1);
  const record = asRecord(latest);
  const parts = record?.parts;
  if (!Array.isArray(parts)) return false;
  return parts.some((part) => {
    const partRecord = asRecord(part);
    const state = asRecord(partRecord?.state);
    return state?.status === "running";
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
          const text = typeof partRecord?.text === "string" ? partRecord.text : undefined;
          return {
            id: partRecord?.id,
            type: partRecord?.type,
            textLength: text?.length,
            textTail: text?.slice(-96),
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

// Bound read probes independently of provider responsiveness, and release them
// immediately when this watchdog generation is stopped.
async function probe<T>(request: (signal: AbortSignal) => Promise<T>, parent: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  parent.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), ABORT_REQUEST_TIMEOUT_MS);
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("Watchdog probe cancelled or timed out"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  if (parent.aborted) controller.abort();
  try {
    return await Promise.race([cancelled, request(controller.signal)]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", onParentAbort);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

async function getMessages(sessionId: string, directory: string, signal: AbortSignal): Promise<unknown[] | null> {
  try {
    const { data, error } = await probe((probeSignal) => opencodeClient.session.messages({ sessionID: sessionId, directory, limit: MESSAGE_LIMIT }, { signal: probeSignal }), signal);
    if (error || !Array.isArray(data)) return null;
    return data as unknown[];
  } catch (error) {
    logger.debug(`[StallWatchdog] Message probe failed: session=${sessionId}`, error);
    return null;
  }
}

async function getStatus(sessionId: string, directory: string, signal: AbortSignal): Promise<SessionStatus | null> {
  try {
    const { data, error } = await probe((probeSignal) => opencodeClient.session.status({ directory }, { signal: probeSignal }), signal);
    if (error || !data) return null;
    return ((data as Record<string, SessionStatus>)[sessionId] ?? null) as SessionStatus | null;
  } catch (error) {
    logger.debug(`[StallWatchdog] Status probe failed: session=${sessionId}`, error);
    return null;
  }
}

async function requestAbort(sessionId: string, directory: string): Promise<boolean> {
  markAbortExpected(sessionId);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ABORT_REQUEST_TIMEOUT_MS);
  try {
    const { data, error } = await opencodeClient.session.abort({ sessionID: sessionId, directory }, { signal: controller.signal });
    logger.warn(`[StallWatchdog] Abort result: session=${sessionId}, result=${String(data)}, error=${error ? "yes" : "no"}`);
    return !error && data === true;
  } catch (error) {
    logger.warn(`[StallWatchdog] Abort request failed: session=${sessionId}`, error);
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function waitForIdle(sessionId: string, directory: string, signal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + ABORT_CONFIRMATION_TIMEOUT_MS;
  let lastStatus: SessionStatus | null = null;
  while (!signal.aborted && Date.now() < deadline) {
    const status = await getStatus(sessionId, directory, signal);
    if (status) lastStatus = status;
    if (status?.type === "idle" || status?.type === "error") return true;
    await sleep(POLL_INTERVAL_MS);
  }
  logger.warn(`[StallWatchdog] Abort confirmation timed out: session=${sessionId}, lastStatus=${lastStatus?.type ?? "unknown"}`);
  return false;
}

async function clearLocalRunState(sessionId: string, reason: string): Promise<void> {
  foregroundSessionState.markIdle(sessionId);
  assistantRunState.clearRun(sessionId, reason);
  await markAttachedSessionIdle(sessionId);
}

export interface StalledSessionInfo {
  sessionId: string;
  directory: string;
  attempt: number;
  agent?: string;
  modelConfig?: { providerID: string; modelID: string };
  variant?: string;
}

export interface StartSessionStallWatchdogOptions {
  sessionId: string;
  directory: string;
  model: string;
  agent?: string;
  modelConfig?: { providerID: string; modelID: string };
  variant?: string;
  attempt?: number;
  onStalled: (info: StalledSessionInfo) => void | Promise<void>;
}

export function startSessionStallWatchdog(options: StartSessionStallWatchdogOptions): void {
  if (activeWatchdogs.has(options.sessionId)) return;
  const attempt = options.attempt ?? 1;
  const controller = new AbortController();
  activeWatchdogs.set(options.sessionId, controller);

  void (async () => {
    let lastFingerprint = "";
    let lastMeaningfulProgressAt = Date.now();
    logger.debug(`[StallWatchdog] Started: session=${options.sessionId}, model=${options.model}, attempt=${attempt}, stallAfterMs=${STALL_AFTER_MS}`);
    try {
      while (!controller.signal.aborted) {
        await sleep(POLL_INTERVAL_MS);
        if (controller.signal.aborted) return;
        const status = await getStatus(options.sessionId, options.directory, controller.signal);
        if (controller.signal.aborted) return;
        if (!status) continue;
        if (status.type === "idle" || status.type === "error") return;
        if (status.type !== "busy" && status.type !== "retry") continue;
        const messages = await getMessages(options.sessionId, options.directory, controller.signal);
        if (controller.signal.aborted) return;
        if (!messages) continue;
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
        if (controller.signal.aborted) return;
        if (!aborted) {
          logger.error(`[StallWatchdog] Could not confirm abort request: session=${options.sessionId}; preserving local busy state.`);
          lastMeaningfulProgressAt = Date.now();
          continue;
        }
        const idle = await waitForIdle(options.sessionId, options.directory, controller.signal);
        if (controller.signal.aborted) return;
        if (!idle) {
          logger.error(`[StallWatchdog] Abort acknowledged but session did not become idle: session=${options.sessionId}; preserving local busy state.`);
          lastMeaningfulProgressAt = Date.now();
          continue;
        }
        await clearLocalRunState(options.sessionId, "stall_watchdog_abort_confirmed");
        if (controller.signal.aborted) return;
        logger.warn(`[StallWatchdog] Recovered stalled session: session=${options.sessionId}, model=${options.model}, attempt=${attempt}`);
        if (activeWatchdogs.get(options.sessionId) === controller) activeWatchdogs.delete(options.sessionId);
        try {
          await options.onStalled({
            sessionId: options.sessionId,
            directory: options.directory,
            attempt,
            agent: options.agent,
            modelConfig: options.modelConfig,
            variant: options.variant,
          });
        } catch (error) {
          logger.error(`[StallWatchdog] onStalled callback failed: session=${options.sessionId}, attempt=${attempt}`, error);
        }
        return;
      }
    } catch (error) {
      logger.error(`[StallWatchdog] Unexpected watchdog failure: session=${options.sessionId}`, error);
    } finally {
      if (activeWatchdogs.get(options.sessionId) === controller) activeWatchdogs.delete(options.sessionId);
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
