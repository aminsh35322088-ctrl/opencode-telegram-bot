import { opencodeClient } from "../../opencode/client.js";
import { foregroundSessionState } from "../managers/foreground-session-state-manager.js";
import { assistantRunState } from "../managers/assistant-run-state-manager.js";
import { markAttachedSessionIdle } from "./attach-service.js";
import { logger } from "../../utils/logger.js";
import { hasActiveToolCall } from "../managers/tool-activity-manager.js";

const POLL_INTERVAL_MS = 5000;
const STALL_AFTER_MS = 4 * 60 * 1000;
const MAX_RETRY_LIVENESS_MS = 30 * 60 * 1000;
const MAX_RUNNING_TOOL_LIVENESS_MS = 30 * 60 * 1000;
const ABORT_REQUEST_TIMEOUT_MS = 5000;
const ABORT_CONFIRMATION_TIMEOUT_MS = 8000;
const MESSAGE_LIMIT = 6;

type SessionStatus = { type?: string };

interface ActiveWatchdog { controller: AbortController; generation: object; }
const activeWatchdogs = new Map<string, ActiveWatchdog>();
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

async function requestAbort(
  sessionId: string,
  directory: string,
  parentSignal: AbortSignal,
): Promise<boolean> {
  try {
    const { data, error } = await probe(
      (signal) => opencodeClient.session.abort({ sessionID: sessionId, directory }, { signal }),
      parentSignal,
    );
    logger.warn(`[StallWatchdog] Abort result: session=${sessionId}, result=${String(data)}, error=${error ? "yes" : "no"}`);
    return !error && data === true;
  } catch (error) {
    logger.warn(`[StallWatchdog] Abort request failed: session=${sessionId}`, error);
    return false;
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

export interface StallNoticeInfo {
  sessionId: string;
  directory: string;
  model: string;
  stalledForMs: number;
}

type StallNoticeSender = (info: StallNoticeInfo) => Promise<void> | void;
type StallRecoveryHandler = (sessionId: string, reason: string) => Promise<void> | void;

let stallNoticeSender: StallNoticeSender | null = null;
let stallRecoveryHandler: StallRecoveryHandler | null = null;

export function setStallNoticeSender(sender: StallNoticeSender | null): void {
  stallNoticeSender = sender;
}

export function setStallRecoveryHandler(handler: StallRecoveryHandler | null): void {
  stallRecoveryHandler = handler;
}

async function recoverLocalRunState(sessionId: string, reason: string): Promise<void> {
  await clearLocalRunState(sessionId, reason);
  if (!stallRecoveryHandler) return;
  try {
    await stallRecoveryHandler(sessionId, reason);
  } catch (error) {
    logger.warn(`[StallWatchdog] Terminal recovery cleanup failed: session=${sessionId}`, error);
  }
}

async function notifyStall(info: StallNoticeInfo): Promise<void> {
  if (!stallNoticeSender) return;
  try {
    await stallNoticeSender(info);
  } catch (error) {
    logger.warn(`[StallWatchdog] Stall notice delivery failed: session=${info.sessionId}`, error);
  }
}

export interface StartSessionStallWatchdogOptions {
  sessionId: string;
  directory: string;
  model: string;
  agent?: string;
  modelConfig?: { providerID: string; modelID: string };
  variant?: string;
  attempt?: number;
  /** @deprecated OpenCode owns inference retries; the watchdog never re-prompts. */
  onStalled?: (info: StalledSessionInfo) => void | Promise<void>;
}

export function startSessionStallWatchdog(options: StartSessionStallWatchdogOptions): void {
  const previous = activeWatchdogs.get(options.sessionId);
  previous?.controller.abort();
  const attempt = options.attempt ?? 1;
  const controller = new AbortController();
  const generation = {};
  const activeWatchdog: ActiveWatchdog = { controller, generation };
  activeWatchdogs.set(options.sessionId, activeWatchdog);
  const isCurrent = () => {
    const current = activeWatchdogs.get(options.sessionId);
    return current?.controller === controller && current.generation === generation;
  };

  void (async () => {
    let lastFingerprint = "";
    let lastMeaningfulProgressAt = Date.now();
    let retryStartedAt: number | undefined;
    let runningToolStartedAt: number | undefined;
    logger.debug(`[StallWatchdog] Started: session=${options.sessionId}, model=${options.model}, attempt=${attempt}, stallAfterMs=${STALL_AFTER_MS}`);
    try {
      while (isCurrent() && !controller.signal.aborted) {
        await sleep(POLL_INTERVAL_MS);
        if (!isCurrent() || controller.signal.aborted) return;
        const status = await getStatus(options.sessionId, options.directory, controller.signal);
        if (!isCurrent() || controller.signal.aborted) return;
        if (!status) continue;
        if (status.type === "idle" || status.type === "error") {
          const run = assistantRunState.getRun(options.sessionId);
          const hasLocalRun = run !== null || foregroundSessionState.isSessionBusy(options.sessionId);
          if (hasLocalRun) {
            await recoverLocalRunState(options.sessionId, "terminal_status_recovered");
            if (!run?.hasCompletedResponse) {
              await notifyStall({
                sessionId: options.sessionId,
                directory: options.directory,
                model: options.model,
                stalledForMs: 0,
              });
            }
          }
          return;
        }
        if (status.type !== "busy" && status.type !== "retry") {
          retryStartedAt = undefined;
          runningToolStartedAt = undefined;
          continue;
        }

        let livenessExpired = false;
        if (status.type === "retry") {
          retryStartedAt ??= Date.now();
          if (Date.now() - retryStartedAt < MAX_RETRY_LIVENESS_MS) {
            lastMeaningfulProgressAt = Date.now();
            continue;
          }
          livenessExpired = true;
        } else {
          retryStartedAt = undefined;
        }

        if (hasActiveToolCall(options.sessionId)) {
          runningToolStartedAt ??= Date.now();
          if (Date.now() - runningToolStartedAt < MAX_RUNNING_TOOL_LIVENESS_MS) {
            lastMeaningfulProgressAt = Date.now();
            continue;
          }
          livenessExpired = true;
        }

        let messages: unknown[] | null = null;
        if (!livenessExpired) {
          messages = await getMessages(options.sessionId, options.directory, controller.signal);
          if (!isCurrent() || controller.signal.aborted) return;
          if (!messages) continue;
          if (hasRunningToolPart(messages)) {
            runningToolStartedAt ??= Date.now();
            if (Date.now() - runningToolStartedAt < MAX_RUNNING_TOOL_LIVENESS_MS) {
              lastMeaningfulProgressAt = Date.now();
              continue;
            }
            livenessExpired = true;
          }
        }

        if (!livenessExpired) {
          const fingerprint = buildMeaningfulFingerprint(messages as unknown[]);
          if (fingerprint !== lastFingerprint) {
            lastFingerprint = fingerprint;
            lastMeaningfulProgressAt = Date.now();
            runningToolStartedAt = undefined;
            continue;
          }
        }

        const stalledForMs = livenessExpired
          ? Date.now() - (retryStartedAt ?? runningToolStartedAt ?? lastMeaningfulProgressAt)
          : Date.now() - lastMeaningfulProgressAt;
        if (stalledForMs < STALL_AFTER_MS) continue;
        logger.warn(`[StallWatchdog] Busy session made no progress: session=${options.sessionId}, model=${options.model}, stalledForMs=${stalledForMs}. Requesting safety abort without re-prompting.`);
        const aborted = await requestAbort(options.sessionId, options.directory, controller.signal);
        if (!isCurrent() || controller.signal.aborted) return;
        if (!aborted) {
          logger.error(`[StallWatchdog] Could not confirm abort request: session=${options.sessionId}; preserving local busy state.`);
          lastMeaningfulProgressAt = Date.now();
          continue;
        }
        const idle = await waitForIdle(options.sessionId, options.directory, controller.signal);
        if (!isCurrent() || controller.signal.aborted) return;
        if (!idle) {
          logger.error(`[StallWatchdog] Abort acknowledged but session did not become idle: session=${options.sessionId}; preserving local busy state.`);
          lastMeaningfulProgressAt = Date.now();
          continue;
        }
        await recoverLocalRunState(options.sessionId, "stall_watchdog_abort_confirmed");
        if (!isCurrent() || controller.signal.aborted) return;
        logger.warn(`[StallWatchdog] Stopped genuinely stalled busy session: session=${options.sessionId}, model=${options.model}, attempt=${attempt}. No synthetic retry was dispatched.`);
        await notifyStall({
          sessionId: options.sessionId,
          directory: options.directory,
          model: options.model,
          stalledForMs,
        });
        if (isCurrent()) activeWatchdogs.delete(options.sessionId);
        return;
      }
    } catch (error) {
      logger.error(`[StallWatchdog] Unexpected watchdog failure: session=${options.sessionId}`, error);
    } finally {
      if (isCurrent()) activeWatchdogs.delete(options.sessionId);
    }
  })();
}

export function stopSessionStallWatchdog(sessionId: string): void {
  const activeWatchdog = activeWatchdogs.get(sessionId);
  if (!activeWatchdog) return;
  activeWatchdog.controller.abort();
  activeWatchdogs.delete(sessionId);
}

export function __resetSessionStallWatchdogsForTests(): void {
  for (const activeWatchdog of activeWatchdogs.values()) activeWatchdog.controller.abort();
  activeWatchdogs.clear();
}
