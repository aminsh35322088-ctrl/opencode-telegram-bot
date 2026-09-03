import os from "node:os";
import { config } from "../config.js";
import { getCurrentSession } from "../app/services/session-service.js";
import { logger } from "./logger.js";

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_BUSY_WARN_MS = 300_000;
const REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_EVENT_LOOP_WARN_MS = 2_000;
const DEFAULT_EVENT_LOOP_CRITICAL_MS = 10_000;

type SessionStatus = "busy" | "retry" | "idle" | "not-found" | "unknown";

type WatchdogSnapshot = {
  sessionId: string | null;
  sessionStatus: SessionStatus;
  sessionBusyForMs: number;
  health: "healthy" | "unhealthy" | "timeout" | "unknown";
  healthLatencyMs: number | null;
  eventLoopLagMs: number;
};

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function apiBaseUrl(): string {
  return config.opencode.apiUrl.replace(/\/+$/, "");
}

function authHeaders(): Record<string, string> {
  if (!config.opencode.password) return {};
  const credentials = `${config.opencode.username}:${config.opencode.password}`;
  return { Authorization: `Basic ${Buffer.from(credentials).toString("base64")}` };
}

function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

function extractSessionStatus(data: unknown, sessionId: string): SessionStatus {
  if (!data || typeof data !== "object") return "unknown";
  const record = data as Record<string, unknown>;
  const direct = record[sessionId];
  if (direct && typeof direct === "object") {
    const type = (direct as Record<string, unknown>).type;
    if (type === "busy" || type === "retry" || type === "idle") return type;
  }
  if (record.type === "busy" || record.type === "retry" || record.type === "idle") return record.type;
  return "unknown";
}

async function checkHealth(): Promise<{ status: WatchdogSnapshot["health"]; latencyMs: number | null }> {
  const startedAt = Date.now();
  try {
    const response = await fetch(`${apiBaseUrl()}/global/health`, {
      headers: authHeaders(),
      signal: timeoutSignal(REQUEST_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) return { status: "unhealthy", latencyMs };
    const data = (await response.json()) as { healthy?: unknown };
    return { status: data.healthy === true ? "healthy" : "unhealthy", latencyMs };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return { status: "timeout", latencyMs };
    }
    return { status: "unknown", latencyMs };
  }
}

async function checkSession(sessionId: string): Promise<{ status: SessionStatus; elapsedMs: number }> {
  const startedAt = Date.now();
  try {
    const response = await fetch(`${apiBaseUrl()}/session/status`, {
      headers: authHeaders(),
      signal: timeoutSignal(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return { status: "unknown", elapsedMs: Date.now() - startedAt };
    return {
      status: extractSessionStatus(await response.json(), sessionId),
      elapsedMs: Date.now() - startedAt,
    };
  } catch {
    return { status: "unknown", elapsedMs: Date.now() - startedAt };
  }
}

export class RuntimeObservabilityWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private busySinceBySession = new Map<string, number>();
  private warnedBusySessions = new Set<string>();
  private lastSnapshot: WatchdogSnapshot | null = null;
  private intervalMs = DEFAULT_INTERVAL_MS;
  private busyWarnMs = DEFAULT_BUSY_WARN_MS;
  private eventLoopWarnMs = DEFAULT_EVENT_LOOP_WARN_MS;
  private eventLoopCriticalMs = DEFAULT_EVENT_LOOP_CRITICAL_MS;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.intervalMs = parsePositiveInteger(process.env.OBSERVABILITY_INTERVAL_MS, DEFAULT_INTERVAL_MS);
    this.busyWarnMs = parsePositiveInteger(process.env.OBSERVABILITY_BUSY_WARN_MS, DEFAULT_BUSY_WARN_MS);
    this.eventLoopWarnMs = parsePositiveInteger(process.env.OBSERVABILITY_EVENT_LOOP_WARN_MS, DEFAULT_EVENT_LOOP_WARN_MS);
    this.eventLoopCriticalMs = Math.max(
      this.eventLoopWarnMs,
      parsePositiveInteger(process.env.OBSERVABILITY_EVENT_LOOP_CRITICAL_MS, DEFAULT_EVENT_LOOP_CRITICAL_MS),
    );

    logger.info(
      `[RuntimeWatchdog] enabled intervalMs=${this.intervalMs} busyWarnMs=${this.busyWarnMs} eventLoopWarnMs=${this.eventLoopWarnMs} eventLoopCriticalMs=${this.eventLoopCriticalMs}`,
    );
    void this.sample("startup");
    this.timer = setInterval(() => void this.sample("interval"), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
    this.busySinceBySession.clear();
    this.warnedBusySessions.clear();
    this.lastSnapshot = null;
    logger.info("[RuntimeWatchdog] stopped");
  }

  private async sample(reason: "startup" | "interval"): Promise<void> {
    if (!this.running) return;

    const loopStartedAt = Date.now();
    const session = getCurrentSession();
    const sessionId = session?.id ?? null;
    const healthPromise = checkHealth();
    const sessionPromise = sessionId ? checkSession(sessionId) : Promise.resolve({ status: "not-found" as const, elapsedMs: 0 });
    const [health, sessionResult] = await Promise.all([healthPromise, sessionPromise]);

    const eventLoopLagMs = Math.max(0, Date.now() - loopStartedAt);
    const now = Date.now();
    let sessionBusyForMs = 0;

    if (sessionId && (sessionResult.status === "busy" || sessionResult.status === "retry")) {
      const busySince = this.busySinceBySession.get(sessionId) ?? now;
      this.busySinceBySession.set(sessionId, busySince);
      sessionBusyForMs = now - busySince;

      if (sessionBusyForMs >= this.busyWarnMs && !this.warnedBusySessions.has(sessionId)) {
        this.warnedBusySessions.add(sessionId);
        logger.warn(
          `[RuntimeWatchdog] phase=stuck_suspected session=${sessionId} state=${sessionResult.status} busyForMs=${sessionBusyForMs} health=${health.status} healthLatencyMs=${health.latencyMs ?? "unknown"} eventLoopLagMs=${eventLoopLagMs}`,
        );
      }
    } else if (sessionId) {
      this.busySinceBySession.delete(sessionId);
      this.warnedBusySessions.delete(sessionId);
    }

    for (const knownSessionId of this.busySinceBySession.keys()) {
      if (knownSessionId !== sessionId) {
        this.busySinceBySession.delete(knownSessionId);
        this.warnedBusySessions.delete(knownSessionId);
      }
    }

    const snapshot: WatchdogSnapshot = {
      sessionId,
      sessionStatus: sessionResult.status,
      sessionBusyForMs,
      health: health.status,
      healthLatencyMs: health.latencyMs,
      eventLoopLagMs,
    };
    this.lastSnapshot = snapshot;

    logger.info(
      `[RuntimeWatchdog] phase=heartbeat reason=${reason} pid=${process.pid} uptimeSec=${Math.round(process.uptime())} rssMb=${Math.round(process.memoryUsage().rss / 1024 / 1024)} heapUsedMb=${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} cpuLoad1=${os.loadavg()[0]?.toFixed(2) ?? "unknown"} session=${sessionId ?? "none"} sessionState=${sessionResult.status} busyForMs=${sessionBusyForMs} sessionCheckMs=${sessionResult.elapsedMs} health=${health.status} healthLatencyMs=${health.latencyMs ?? "unknown"} eventLoopLagMs=${eventLoopLagMs}`,
    );

    if (eventLoopLagMs >= this.eventLoopCriticalMs) {
      logger.error(`[RuntimeWatchdog] phase=event_loop_critical lagMs=${eventLoopLagMs}`);
    } else if (eventLoopLagMs >= this.eventLoopWarnMs) {
      logger.warn(`[RuntimeWatchdog] phase=event_loop_lag lagMs=${eventLoopLagMs}`);
    }

    if (health.status !== "healthy") {
      logger.warn(`[RuntimeWatchdog] phase=opencode_health_anomaly status=${health.status} latencyMs=${health.latencyMs ?? "unknown"} session=${sessionId ?? "none"} sessionState=${sessionResult.status}`);
    }
  }

  getLastSnapshot(): WatchdogSnapshot | null {
    return this.lastSnapshot;
  }
}

export const runtimeObservabilityWatchdog = new RuntimeObservabilityWatchdog();
