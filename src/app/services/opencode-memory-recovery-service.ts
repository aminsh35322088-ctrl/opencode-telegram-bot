import { RailwayResourceGovernor } from "@opencode-telegram/native-runtime";
import { runCoreIdleMaintenance } from "../../core/native-core-service.js";
import { opencodeAutoRestartService } from "../../opencode/auto-restart.js";
import { logger } from "../../utils/logger.js";

const CHECK_INTERVAL_MS = 30_000;
const STARTUP_GRACE_MS = 90_000;
const RECOVERY_COOLDOWN_MS = 15 * 60_000;
const WORKING_SET_PRESSURE_THRESHOLD = 0.78;
const RAW_TOTAL_PRESSURE_THRESHOLD = 0.86;

let recoveryInFlight: Promise<boolean> | null = null;
let lastRecoveryAt = 0;

function memoryPressureSnapshot(): {
  limitBytes: number;
  totalBytes: number;
  workingSetBytes: number;
  workingSetPressure: number;
  totalPressure: number;
} | null {
  const limitBytes = RailwayResourceGovernor.serviceMemoryLimitBytes();
  if (!limitBytes) return null;
  const totalBytes = RailwayResourceGovernor.serviceMemoryBytes();
  const workingSetBytes = RailwayResourceGovernor.serviceWorkingSetBytes(totalBytes);
  return {
    limitBytes,
    totalBytes,
    workingSetBytes,
    workingSetPressure: workingSetBytes / limitBytes,
    totalPressure: totalBytes / limitBytes,
  };
}

export function isCoreResourcePressureError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Railway resource budget rejects new work|worker capacity exhausted/i.test(message);
}

export async function recoverIdleOpenCodeMemory(
  reason: string,
  force = false,
): Promise<boolean> {
  if (recoveryInFlight) return recoveryInFlight;

  const snapshot = memoryPressureSnapshot();
  if (!snapshot) return false;
  if (force) {
    if (
      snapshot.workingSetPressure < 0.72 &&
      snapshot.totalPressure < 0.82
    ) {
      return false;
    }
  } else if (
    snapshot.workingSetPressure < WORKING_SET_PRESSURE_THRESHOLD ||
    snapshot.totalPressure < RAW_TOTAL_PRESSURE_THRESHOLD
  ) {
    return false;
  }
  if (Date.now() - lastRecoveryAt < RECOVERY_COOLDOWN_MS) return false;

  recoveryInFlight = (async () => {
    const recovered = await runCoreIdleMaintenance(
      "railway_memory_reclaim",
      () => opencodeAutoRestartService.restartForMemoryReclaim(reason),
    );
    if (!recovered) {
      logger.debug(
        `[OpenCodeMemory] reclaim deferred: reason=${reason} workingSet=${(snapshot.workingSetBytes / 1024 / 1024).toFixed(0)}MiB total=${(snapshot.totalBytes / 1024 / 1024).toFixed(0)}MiB`,
      );
      return false;
    }

    lastRecoveryAt = Date.now();
    const after = memoryPressureSnapshot();
    logger.warn(
      `[OpenCodeMemory] reclaimed idle OpenCode: reason=${reason} beforeWorkingSet=${(snapshot.workingSetBytes / 1024 / 1024).toFixed(0)}MiB beforeTotal=${(snapshot.totalBytes / 1024 / 1024).toFixed(0)}MiB afterWorkingSet=${after ? (after.workingSetBytes / 1024 / 1024).toFixed(0) : "unknown"}MiB afterTotal=${after ? (after.totalBytes / 1024 / 1024).toFixed(0) : "unknown"}MiB`,
    );
    return true;
  })().catch((error) => {
    logger.warn("[OpenCodeMemory] idle memory reclaim failed", error);
    return false;
  }).finally(() => {
    recoveryInFlight = null;
  });

  return recoveryInFlight;
}

export class OpenCodeMemoryRecoveryService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;

  start(): void {
    if (this.timer || this.startupTimer) return;

    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void recoverIdleOpenCodeMemory("startup_grace");
      this.timer = setInterval(
        () => void recoverIdleOpenCodeMemory("interval"),
        CHECK_INTERVAL_MS,
      );
      this.timer.unref?.();
    }, STARTUP_GRACE_MS);
    this.startupTimer.unref?.();

    logger.info(
      `[OpenCodeMemory] enabled intervalMs=${CHECK_INTERVAL_MS} cooldownMs=${RECOVERY_COOLDOWN_MS} workingSetThreshold=${Math.round(WORKING_SET_PRESSURE_THRESHOLD * 100)}% totalThreshold=${Math.round(RAW_TOTAL_PRESSURE_THRESHOLD * 100)}%`,
    );
  }

  stop(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.timer) clearInterval(this.timer);
    this.startupTimer = null;
    this.timer = null;
    logger.info("[OpenCodeMemory] stopped");
  }
}

export function __resetOpenCodeMemoryRecoveryStateForTests(): void {
  recoveryInFlight = null;
  lastRecoveryAt = 0;
}

export const opencodeMemoryRecoveryService = new OpenCodeMemoryRecoveryService();
