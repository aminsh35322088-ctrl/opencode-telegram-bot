import { readFile } from "node:fs/promises";
import { assistantRunState } from "../app/managers/assistant-run-state-manager.js";
import { config } from "../config.js";
import { isContainerRuntime } from "../runtime/container.js";
import { logger } from "../utils/logger.js";
import { opencodeClient } from "./client.js";
import { opencodeReadyLifecycle } from "./ready-lifecycle.js";
import {
  findServerPid,
  killServerProcess,
  resolveLocalOpencodeTarget,
  startLocalOpencodeServer,
  type LocalOpencodeTarget,
} from "./process.js";

const SERVER_READY_TIMEOUT_MS = 15000;
const SERVER_READY_POLL_INTERVAL_MS = 500;
const HEALTH_CHECK_TIMEOUT_MS = 5000;
// A single missed health request is not sufficient evidence that the local
// OpenCode process is dead. The SSE subscriber has its own reconnect logic.
const HEALTH_FAILURES_BEFORE_RESTART = 3;
const HEALTH_CHECK_TIMED_OUT = Symbol("health-check-timed-out");
const DEFAULT_RAILWAY_MEMORY_RESTART_RATIO = 0.82;

type CgroupMemoryPressure = {
  usedBytes: number;
  limitBytes: number;
  ratio: number;
};

function memoryRestartRatio(): number | null {
  const configured = process.env.OPENCODE_MEMORY_RESTART_RATIO?.trim();
  if (!configured && !process.env.RAILWAY_PROJECT_ID) return null;
  const value = configured ? Number(configured) : DEFAULT_RAILWAY_MEMORY_RESTART_RATIO;
  return Number.isFinite(value) && value >= 0.6 && value < 0.98 ? value : null;
}

async function readNumberFile(filePath: string): Promise<number | null> {
  try {
    const raw = (await readFile(filePath, "utf8")).trim();
    if (!raw || raw === "max") return null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export async function readCgroupMemoryPressure(): Promise<CgroupMemoryPressure | null> {
  const candidates = [
    ["/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory.max"],
    ["/sys/fs/cgroup/memory/memory.usage_in_bytes", "/sys/fs/cgroup/memory/memory.limit_in_bytes"],
  ] as const;
  for (const [usagePath, limitPath] of candidates) {
    const [usedBytes, limitBytes] = await Promise.all([
      readNumberFile(usagePath),
      readNumberFile(limitPath),
    ]);
    if (!usedBytes || !limitBytes || limitBytes <= 0) continue;
    return { usedBytes, limitBytes, ratio: usedBytes / limitBytes };
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isEnabled(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function shouldSpawnLocalServerInContainer(): boolean {
  return isEnabled(process.env.OPENCODE_AUTO_START_IN_CONTAINER);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof HEALTH_CHECK_TIMED_OUT> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof HEALTH_CHECK_TIMED_OUT>((resolve) => {
        timeout = setTimeout(() => resolve(HEALTH_CHECK_TIMED_OUT), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function isOpencodeServerHealthy(logTimeout = true): Promise<boolean> {
  try {
    const result = await withTimeout(opencodeClient.global.health(), HEALTH_CHECK_TIMEOUT_MS);
    if (result === HEALTH_CHECK_TIMED_OUT) {
      if (logTimeout) logger.warn(`[OpenCodeAutoRestart] Health-check timed out after ${HEALTH_CHECK_TIMEOUT_MS}ms`);
      return false;
    }
    const { data, error } = result;
    return !error && data?.healthy === true;
  } catch (error) {
    if (logTimeout) logger.warn("[OpenCodeAutoRestart] Health-check request failed", error);
    return false;
  }
}

async function waitForOpencodeServerReady(timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isOpencodeServerHealthy(false)) return true;
    await sleep(SERVER_READY_POLL_INTERVAL_MS);
  }
  return false;
}

export class OpencodeAutoRestartService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private localTarget: LocalOpencodeTarget | null = null;
  private started = false;
  private checkInProgress = false;
  private serverWasHealthy = false;
  private consecutiveHealthFailures = 0;
  private managedServerPid: number | null = null;

  async start(): Promise<boolean> {
    if (this.started || !config.opencode.autoRestartEnabled) return false;
    const localTarget = resolveLocalOpencodeTarget(config.opencode.apiUrl);
    if (!localTarget) {
      logger.warn(`[OpenCodeAutoRestart] Disabled because OPENCODE_API_URL is not local: ${config.opencode.apiUrl}`);
      return false;
    }
    const container = isContainerRuntime();
    const spawnInContainer = shouldSpawnLocalServerInContainer();
    this.started = true;
    this.localTarget = localTarget;
    this.consecutiveHealthFailures = 0;
    logger.info(`[OpenCodeAutoRestart] Enabled: host=${localTarget.host}, port=${localTarget.port}, intervalSec=${config.opencode.monitorIntervalSec}, container=${container}, spawnInContainer=${spawnInContainer}, healthTimeoutMs=${HEALTH_CHECK_TIMEOUT_MS}, failuresBeforeRestart=${HEALTH_FAILURES_BEFORE_RESTART}, memoryRestartRatio=${memoryRestartRatio() ?? "off"}`);
    await this.checkAndRestart("startup");
    this.timer = setInterval(() => void this.checkAndRestart("interval"), config.opencode.monitorIntervalSec * 1000);
    this.timer.unref?.();
    return true;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
    this.localTarget = null;
    this.serverWasHealthy = false;
    this.consecutiveHealthFailures = 0;
    this.managedServerPid = null;
  }

  private async checkAndRestart(reason: "startup" | "interval"): Promise<void> {
    if (this.checkInProgress || !this.localTarget) return;
    this.checkInProgress = true;
    try {
      if (await isOpencodeServerHealthy(reason !== "startup")) {
        this.consecutiveHealthFailures = 0;
        if (!this.serverWasHealthy) {
          this.serverWasHealthy = true;
          await opencodeReadyLifecycle.notifyReady(`auto_restart_${reason}`);
        }

        if (reason === "interval") {
          const threshold = memoryRestartRatio();
          const pressure = threshold === null ? null : await readCgroupMemoryPressure();
          if (pressure && threshold !== null && pressure.ratio >= threshold) {
            const usedMb = Math.round(pressure.usedBytes / (1024 * 1024));
            const limitMb = Math.round(pressure.limitBytes / (1024 * 1024));
            if (assistantRunState.hasActiveRuns()) {
              logger.warn(
                `[OpenCodeAutoRestart] Memory pressure detected but restart deferred for active AI run(s): used=${usedMb}MB, limit=${limitMb}MB, ratio=${pressure.ratio.toFixed(3)}, threshold=${threshold}`,
              );
              return;
            }

            logger.warn(
              `[OpenCodeAutoRestart] Recycling idle OpenCode before OOM pressure: used=${usedMb}MB, limit=${limitMb}MB, ratio=${pressure.ratio.toFixed(3)}, threshold=${threshold}`,
            );
            this.serverWasHealthy = false;
            opencodeReadyLifecycle.notifyUnavailable("memory_pressure");
            await this.startServer("memory_pressure");
          }
        }
        return;
      }
      if (reason === "startup") {
        await this.startServer("startup");
        return;
      }

      this.consecutiveHealthFailures += 1;
      logger.warn(`[OpenCodeAutoRestart] Health-check failed: reason=${reason}, consecutiveFailures=${this.consecutiveHealthFailures}/${HEALTH_FAILURES_BEFORE_RESTART}`);
      if (this.consecutiveHealthFailures < HEALTH_FAILURES_BEFORE_RESTART) return;

      this.consecutiveHealthFailures = 0;
      this.serverWasHealthy = false;
      opencodeReadyLifecycle.notifyUnavailable(`auto_restart_${reason}`);
      await this.startServer(reason);
    } catch (error) {
      logger.error("[OpenCodeAutoRestart] Failed to check or restart OpenCode server", error);
    } finally {
      this.checkInProgress = false;
    }
  }

  private async recoverAfterUnexpectedExit(pid: number): Promise<void> {
    if (!this.started || !this.localTarget || this.managedServerPid !== null) return;
    if (this.checkInProgress) return;

    this.checkInProgress = true;
    try {
      this.serverWasHealthy = false;
      this.consecutiveHealthFailures = 0;
      opencodeReadyLifecycle.notifyUnavailable("process_exit");
      logger.warn(`[OpenCodeAutoRestart] Recovering immediately after OpenCode process exit: pid=${pid}`);
      await this.startServer("interval");
    } catch (error) {
      logger.error("[OpenCodeAutoRestart] Failed immediate recovery after OpenCode process exit", error);
    } finally {
      this.checkInProgress = false;
    }
  }

  private async stopExistingServerIfNeeded(): Promise<void> {
    if (!this.localTarget) return;

    const existingPid = await findServerPid(this.localTarget.port);
    if (existingPid === null) return;

    if (existingPid === process.pid) {
      logger.error(`[OpenCodeAutoRestart] Refusing to stop bot process that owns OpenCode port: pid=${existingPid}, port=${this.localTarget.port}`);
      return;
    }

    logger.warn(`[OpenCodeAutoRestart] Existing listener found before recovery: pid=${existingPid}, port=${this.localTarget.port}; stopping it before spawn`);
    const stopped = await killServerProcess(existingPid);
    logger.info(`[OpenCodeAutoRestart] Existing OpenCode listener stop result: pid=${existingPid}, stopped=${stopped}`);
  }

  private async startServer(reason: "startup" | "interval" | "memory_pressure"): Promise<void> {
    if (!this.localTarget) return;
    if (isContainerRuntime() && !shouldSpawnLocalServerInContainer()) {
      logger.warn(`[OpenCodeAutoRestart] OpenCode server is unavailable; local spawn is disabled in this container. Set OPENCODE_AUTO_START_IN_CONTAINER=true to enable it.`);
      return;
    }
    const prefix =
      reason === "startup"
        ? "Startup"
        : reason === "memory_pressure"
          ? "Idle memory-pressure recycle"
          : `Recovery after ${HEALTH_FAILURES_BEFORE_RESTART} consecutive failed checks`;
    logger.info(`[OpenCodeAutoRestart] ${prefix}: preparing local OpenCode server on port=${this.localTarget.port}`);
    await this.stopExistingServerIfNeeded();
    logger.info(`[OpenCodeAutoRestart] ${prefix}: starting local OpenCode server on port=${this.localTarget.port}`);
    const childProcess = startLocalOpencodeServer(this.localTarget);
    const pid = childProcess.pid ?? null;
    this.managedServerPid = pid;
    childProcess.once("error", (error) => logger.error(`[OpenCodeAutoRestart] OpenCode server process failed to start: pid=${pid ?? "unknown"}`, error));
    childProcess.once("exit", (code, signal) => {
      if (this.managedServerPid === pid) this.managedServerPid = null;
      logger.error(`[OpenCodeAutoRestart] OpenCode server exited: pid=${pid ?? "unknown"}, code=${code ?? "null"}, signal=${signal ?? "none"}`);
      if (this.serverWasHealthy && this.started) {
        void this.recoverAfterUnexpectedExit(pid ?? -1);
      }
    });
    childProcess.unref();
    const ready = await waitForOpencodeServerReady(SERVER_READY_TIMEOUT_MS);
    if (!ready) {
      if (this.managedServerPid === pid) this.managedServerPid = null;
      logger.warn(`[OpenCodeAutoRestart] OpenCode server was started but did not become ready: pid=${pid ?? "unknown"}, port=${this.localTarget.port}`);
      return;
    }
    this.serverWasHealthy = true;
    this.managedServerPid = pid;
    logger.info(`[OpenCodeAutoRestart] OpenCode server recovered: pid=${pid ?? "unknown"}, port=${this.localTarget.port}`);
    await opencodeReadyLifecycle.notifyReady(`auto_restart_${reason}`);
  }
}

export const opencodeAutoRestartService = new OpencodeAutoRestartService();
