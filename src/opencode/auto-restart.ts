import type { ChildProcess } from "node:child_process";
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
  type LocalOpencodeTarget } from "./process.js";

const SERVER_READY_TIMEOUT_MS = 15000;
const SERVER_READY_POLL_INTERVAL_MS = 500;
const HEALTH_CHECK_TIMEOUT_MS = 5000;
// A single missed health request is not sufficient evidence that the local
// OpenCode process is dead. The SSE subscriber has its own reconnect logic.
const HEALTH_FAILURES_BEFORE_RESTART = 3;
const HEALTH_CHECK_TIMED_OUT = Symbol("health-check-timed-out");

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

  private essentialFailed = false;
  private managedChild: {
    child: ChildProcess;
    completion: Promise<boolean>;
    planned: boolean;
  } | null = null;

  constructor(private readonly exitEssentialApplication: (code: number) => void = (code) => process.exit(code)) {}

  private failEssential(reason: string): void {
    if (this.essentialFailed) return;
    this.essentialFailed = true;
    logger.error(`[OpenCodeAutoRestart] Essential Core authority lost: ${reason}`);
    this.stop();
    this.exitEssentialApplication(75);
  }

  async start(): Promise<boolean> {
    if (this.essentialFailed || this.started || !config.opencode.autoRestartEnabled) return false;
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
    logger.info(
      `[OpenCodeAutoRestart] Enabled: host=${localTarget.host}, port=${localTarget.port}, intervalSec=${config.opencode.monitorIntervalSec}, container=${container}, spawnInContainer=${spawnInContainer}, healthTimeoutMs=${HEALTH_CHECK_TIMEOUT_MS}, failuresBeforeRestart=${HEALTH_FAILURES_BEFORE_RESTART}`,
    );
    await this.checkAndRestart("startup");
    if (this.essentialFailed) return false;
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

  async restartForConfigChange(reason: string): Promise<boolean> {
    return this.restartManagedServer("config", reason);
  }

  async restartForMemoryReclaim(reason: string): Promise<boolean> {
    return this.restartManagedServer("memory", reason);
  }

  private async restartManagedServer(source: "config" | "memory",
    reason: string): Promise<boolean> {
    if (!this.started || !this.localTarget || this.checkInProgress) return false;

    this.checkInProgress = true;
    try {
      this.serverWasHealthy = false;
      this.consecutiveHealthFailures = 0;
      const lifecycleReason = source === "config"
        ? `config_change_${reason}`
        : `memory_reclaim_${reason}`;
      opencodeReadyLifecycle.notifyUnavailable(lifecycleReason);
      if (source === "config") {
        logger.info(`[OpenCodeAutoRestart] Restarting OpenCode to apply config change: reason=${reason}`);
      } else {
        logger.warn(`[OpenCodeAutoRestart] Recycling idle OpenCode to reclaim memory: reason=${reason}`);
      }
      return await this.startServer(source);
    } catch (error) {
      if (isContainerRuntime()) this.failEssential("planned Core restart failed");
      logger.error(`[OpenCodeAutoRestart] Failed ${source} restart: reason=${reason}`, error);
      return false;
    } finally {
      this.checkInProgress = false;
    }
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
      if (isContainerRuntime()) this.failEssential("Core recovery failed");
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

  private async stopExistingServerIfNeeded(reason: "startup" | "interval" | "config" | "memory"): Promise<boolean> {
    if (!this.localTarget) return false;

    const existingPid = await findServerPid(this.localTarget.port);
    if (isContainerRuntime()) {
      const managed = this.managedChild;
      if (!managed && existingPid === null) return !this.essentialFailed;
      if (!managed || (existingPid !== null && existingPid !== managed.child.pid) || (reason !== "config" && reason !== "memory") || this.essentialFailed) {
        this.failEssential("listener retirement has no intentional owned replacement");
        return false;
      }
      managed.planned = true;
      const stopped = await killServerProcess(managed.child.pid!);
      const joined = await withTimeout(managed.completion, 10_000);
      if (!stopped || joined !== true || this.essentialFailed) {
        this.failEssential("planned Core retirement was not joined exit0");
        return false;
      }
      this.managedChild = null;
      return true;
    }
    if (existingPid === null) return true;

    if (existingPid === process.pid) {
      logger.error(`[OpenCodeAutoRestart] Refusing to stop bot process that owns OpenCode port: pid=${existingPid}, port=${this.localTarget.port}`);
      return true;
    }

    logger.warn(`[OpenCodeAutoRestart] Existing listener found before recovery: pid=${existingPid}, port=${this.localTarget.port}; stopping it before spawn`);
    const stopped = await killServerProcess(existingPid);
    logger.info(`[OpenCodeAutoRestart] Existing OpenCode listener stop result: pid=${existingPid}, stopped=${stopped}`);
    return true;
  }

  private async startServer(reason: "startup" | "interval" | "config" | "memory"): Promise<boolean> {
    if (!this.localTarget || this.essentialFailed) return false;
    if (isContainerRuntime() && !shouldSpawnLocalServerInContainer()) {
      logger.warn(`[OpenCodeAutoRestart] OpenCode server is unavailable; local spawn is disabled in this container. Set OPENCODE_AUTO_START_IN_CONTAINER=true to enable it.`);
      return false;
    }
    const prefix = reason === "startup"
      ? "Startup"
      : reason === "config"
        ? "Config reload"
        : reason === "memory"
          ? "Memory reclaim"
          : `Recovery after ${HEALTH_FAILURES_BEFORE_RESTART} consecutive failed checks`;
    logger.info(`[OpenCodeAutoRestart] ${prefix}: preparing local OpenCode server on port=${this.localTarget.port}`);
    if (!(await this.stopExistingServerIfNeeded(reason))) return false;
    logger.info(`[OpenCodeAutoRestart] ${prefix}: starting local OpenCode server on port=${this.localTarget.port}`);
    let childProcess: ChildProcess;
    try {
      childProcess = await startLocalOpencodeServer(this.localTarget);
    } catch (error) {
      if (isContainerRuntime()) this.failEssential("Core spawn failed");
      throw error;
    }
    const pid = childProcess.pid ?? null;
    this.managedServerPid = pid;
    // Capture completion before readiness or any further await. Terminal fields
    // also catch completion between the asynchronous spawn return and this code.
    let joined!: (normal: boolean) => void;
    const managed = {
      child: childProcess,
      planned: false,
      completion: new Promise<boolean>((resolve) => {
        joined = resolve;
      }),
    };
    this.managedChild = managed;
    childProcess.once("error", (error) => {
      joined(false);
      logger.error(`[OpenCodeAutoRestart] OpenCode server process failed to start: pid=${pid ?? "unknown"}`, error);
      if (isContainerRuntime()) this.failEssential("Core spawn error");
    });
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      joined(code === 0 && signal === null);
      if (isContainerRuntime() && !(managed.planned && code === 0 && signal === null)) {
        this.failEssential(`Core exit code=${code} signal=${signal}`);
      }
      if (this.managedServerPid === pid) this.managedServerPid = null;
      logger.error(`[OpenCodeAutoRestart] OpenCode server exited: pid=${pid ?? "unknown"}, code=${code ?? "null"}, signal=${signal ?? "none"}`);
      if (!isContainerRuntime() && this.serverWasHealthy && this.started) {
        void this.recoverAfterUnexpectedExit(pid ?? -1);
      }
    };
    childProcess.once("exit", onExit);
    if (childProcess.exitCode != null || childProcess.signalCode != null) {
      onExit(childProcess.exitCode, childProcess.signalCode);
    }
    if (isContainerRuntime() && pid === null) this.failEssential("Core spawn returned no PID");
    if (this.essentialFailed) return false;
    childProcess.unref();
    const ready = await waitForOpencodeServerReady(SERVER_READY_TIMEOUT_MS);
    if (this.essentialFailed) return false;
    if (!ready) {
      if (isContainerRuntime()) this.failEssential("Core readiness was not confirmed");
      if (this.managedServerPid === pid) this.managedServerPid = null;
      logger.warn(`[OpenCodeAutoRestart] OpenCode server was started but did not become ready: pid=${pid ?? "unknown"}, port=${this.localTarget.port}`);
      return false;
    }
    this.serverWasHealthy = true;
    this.managedServerPid = pid;
    logger.info(`[OpenCodeAutoRestart] OpenCode server recovered: pid=${pid ?? "unknown"}, port=${this.localTarget.port}`);
    await opencodeReadyLifecycle.notifyReady(`auto_restart_${reason}`);
    return true;
  }
}

export const opencodeAutoRestartService = new OpencodeAutoRestartService();
