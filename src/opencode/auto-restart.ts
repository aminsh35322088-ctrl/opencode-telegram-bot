import { config } from "../config.js";
import { isContainerRuntime } from "../runtime/container.js";
import { logger } from "../utils/logger.js";
import { opencodeClient } from "./client.js";
import { opencodeReadyLifecycle } from "./ready-lifecycle.js";
import {
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
  } catch {
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
    logger.info(`[OpenCodeAutoRestart] Enabled: host=${localTarget.host}, port=${localTarget.port}, intervalSec=${config.opencode.monitorIntervalSec}, container=${container}, spawnInContainer=${spawnInContainer}, healthTimeoutMs=${HEALTH_CHECK_TIMEOUT_MS}, failuresBeforeRestart=${HEALTH_FAILURES_BEFORE_RESTART}`);
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
      logger.error("[OpenCodeAutoRestart] Failed to check or restart OpenCode server", error);
    } finally {
      this.checkInProgress = false;
    }
  }

  private async startServer(reason: "startup" | "interval"): Promise<void> {
    if (!this.localTarget) return;
    if (isContainerRuntime() && !shouldSpawnLocalServerInContainer()) {
      logger.warn(`[OpenCodeAutoRestart] OpenCode server is unavailable; local spawn is disabled in this container. Set OPENCODE_AUTO_START_IN_CONTAINER=true to enable it.`);
      return;
    }
    const prefix = reason === "startup" ? "Startup" : `Recovery after ${HEALTH_FAILURES_BEFORE_RESTART} consecutive failed checks`;
    logger.info(`[OpenCodeAutoRestart] ${prefix}: starting local OpenCode server on port=${this.localTarget.port}`);
    const childProcess = startLocalOpencodeServer(this.localTarget);
    childProcess.once("error", (error) => logger.error("[OpenCodeAutoRestart] OpenCode server process failed to start", error));
    const pid = childProcess.pid;
    childProcess.unref();
    const ready = await waitForOpencodeServerReady(SERVER_READY_TIMEOUT_MS);
    if (!ready) {
      logger.warn(`[OpenCodeAutoRestart] OpenCode server was started but did not become ready: pid=${pid ?? "unknown"}, port=${this.localTarget.port}`);
      return;
    }
    logger.info(`[OpenCodeAutoRestart] OpenCode server recovered: pid=${pid ?? "unknown"}, port=${this.localTarget.port}`);
    this.serverWasHealthy = true;
    await opencodeReadyLifecycle.notifyReady(`auto_restart_${reason}`);
  }
}

export const opencodeAutoRestartService = new OpencodeAutoRestartService();