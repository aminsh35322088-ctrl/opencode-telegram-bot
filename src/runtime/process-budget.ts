import { exec, execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { RailwayResourceGovernor } from "@opencode-telegram/native-runtime";
import { logger } from "../utils/logger.js";
import { childEnvironment } from "./child-environment.js";

const MiB = 1024 * 1024;
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export type ProcessBudgetKind =
  | "opencode-server"
  | "bot-daemon"
  | "mcp-server"
  | "media"
  | "media-probe"
  | "ssh"
  | "ssh-keygen"
  | "tailscale"
  | "git"
  | "diagnostic"
  | "cleanup"
  | "version-probe";

type ProcessPriority = "critical" | "interactive" | "control" | "background";

export interface ProcessRule {
  readonly maxConcurrent: number;
  readonly reserveBytes: number;
  readonly priority: ProcessPriority;
  readonly pressureCeiling: number;
  readonly defaultTimeoutMs: number | null;
  readonly maxTimeoutMs: number | null;
  readonly maxLifetimeMs: number | null;
}

const RULES: Readonly<Record<ProcessBudgetKind, ProcessRule>> = Object.freeze({
  "opencode-server": { maxConcurrent: 1, reserveBytes: 256 * MiB, priority: "critical", pressureCeiling: 0.98, defaultTimeoutMs: null, maxTimeoutMs: null, maxLifetimeMs: null },
  "bot-daemon": { maxConcurrent: 1, reserveBytes: 192 * MiB, priority: "critical", pressureCeiling: 0.98, defaultTimeoutMs: null, maxTimeoutMs: null, maxLifetimeMs: null },
  "mcp-server": { maxConcurrent: 1, reserveBytes: 96 * MiB, priority: "interactive", pressureCeiling: 0.94, defaultTimeoutMs: null, maxTimeoutMs: null, maxLifetimeMs: 2 * 60 * 60_000 },
  media: { maxConcurrent: 1, reserveBytes: 96 * MiB, priority: "interactive", pressureCeiling: 0.94, defaultTimeoutMs: 60_000, maxTimeoutMs: 90_000, maxLifetimeMs: 90_000 },
  "media-probe": { maxConcurrent: 1, reserveBytes: 24 * MiB, priority: "background", pressureCeiling: 0.95, defaultTimeoutMs: 10_000, maxTimeoutMs: 15_000, maxLifetimeMs: 15_000 },
  ssh: { maxConcurrent: 2, reserveBytes: 24 * MiB, priority: "control", pressureCeiling: 0.97, defaultTimeoutMs: 60_000, maxTimeoutMs: 10 * 60_000, maxLifetimeMs: 10 * 60_000 },
  "ssh-keygen": { maxConcurrent: 1, reserveBytes: 24 * MiB, priority: "control", pressureCeiling: 0.96, defaultTimeoutMs: 15_000, maxTimeoutMs: 20_000, maxLifetimeMs: 20_000 },
  tailscale: { maxConcurrent: 2, reserveBytes: 24 * MiB, priority: "control", pressureCeiling: 0.97, defaultTimeoutMs: 12_000, maxTimeoutMs: 30_000, maxLifetimeMs: 30_000 },
  git: { maxConcurrent: 1, reserveBytes: 48 * MiB, priority: "background", pressureCeiling: 0.95, defaultTimeoutMs: 20_000, maxTimeoutMs: 45_000, maxLifetimeMs: 45_000 },
  diagnostic: { maxConcurrent: 2, reserveBytes: 12 * MiB, priority: "control", pressureCeiling: 0.985, defaultTimeoutMs: 5_000, maxTimeoutMs: 10_000, maxLifetimeMs: 10_000 },
  cleanup: { maxConcurrent: 8, reserveBytes: 8 * MiB, priority: "critical", pressureCeiling: 1.05, defaultTimeoutMs: 5_000, maxTimeoutMs: 10_000, maxLifetimeMs: 10_000 },
  "version-probe": { maxConcurrent: 2, reserveBytes: 12 * MiB, priority: "background", pressureCeiling: 0.95, defaultTimeoutMs: 3_000, maxTimeoutMs: 5_000, maxLifetimeMs: 5_000 },
});

export interface ServiceResourceSnapshot {
  /** Reclaim-aware working set used for admission decisions. */
  readonly memoryUsedBytes: number;
  /** Raw cgroup memory.current, including reclaimable inactive file cache. */
  readonly memoryTotalBytes?: number;
  readonly memoryLimitBytes: number | null;
  readonly memoryPressure: number | null;
  readonly cpuLimitCores: number | null;
}

export interface ProcessBudgetSnapshot extends ServiceResourceSnapshot {
  readonly activeCount: number;
  readonly activeByKind: Readonly<Record<string, number>>;
  readonly serviceProcessCount: number | null;
}

export class ProcessBudgetError extends Error {
  constructor(
    readonly kind: ProcessBudgetKind,
    readonly reason: "category_limit" | "global_limit" | "memory_pressure",
    message: string,
  ) {
    super(message);
    this.name = "ProcessBudgetError";
  }
}

export interface ProcessBudgetLease {
  readonly id: string;
  readonly kind: ProcessBudgetKind;
  readonly admittedAt: number;
  readonly timeoutMs: number | null;
  release(): void;
}

interface ActiveLease {
  readonly id: string;
  readonly kind: ProcessBudgetKind;
  readonly admittedAt: number;
  readonly reserveBytes: number;
  readonly reserveUntil: number;
}

const RESERVATION_WARMUP_MS = 5_000;

const CGROUP_MEMORY_MAX = "/sys/fs/cgroup/memory.max";
const CGROUP_CPU_MAX = "/sys/fs/cgroup/cpu.max";
const CGROUP_PROCS = "/sys/fs/cgroup/cgroup.procs";

async function readText(path: string): Promise<string | null> {
  try { return (await readFile(path, "utf8")).trim(); } catch { return null; }
}

function parsePositiveInt(value: string | null): number | null {
  if (!value || value === "max") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function readCpuLimit(): Promise<number | null> {
  const value = await readText(CGROUP_CPU_MAX);
  if (!value) return null;
  const [quotaText, periodText] = value.split(/\s+/, 2);
  if (!quotaText || quotaText === "max" || !periodText) return null;
  const quota = Number.parseInt(quotaText, 10);
  const period = Number.parseInt(periodText, 10);
  return Number.isFinite(quota) && Number.isFinite(period) && quota > 0 && period > 0 ? quota / period : null;
}

async function resourceSnapshot(): Promise<ServiceResourceSnapshot> {
  const [maxText, cpuLimitCores] = await Promise.all([
    readText(CGROUP_MEMORY_MAX),
    readCpuLimit(),
  ]);
  const envLimitMb = Number.parseInt(process.env.BOT_PROCESS_MEMORY_LIMIT_MB ?? "", 10);
  const envLimit = Number.isFinite(envLimitMb) && envLimitMb > 0 ? envLimitMb * MiB : null;
  const memoryTotalBytes = RailwayResourceGovernor.serviceMemoryBytes();
  const memoryUsedBytes = RailwayResourceGovernor.serviceWorkingSetBytes(memoryTotalBytes);
  const memoryLimitBytes = parsePositiveInt(maxText) ?? RailwayResourceGovernor.serviceMemoryLimitBytes() ?? envLimit;
  return {
    memoryUsedBytes,
    memoryTotalBytes,
    memoryLimitBytes,
    memoryPressure: memoryLimitBytes ? memoryUsedBytes / memoryLimitBytes : null,
    cpuLimitCores,
  };
}

function clampTimeout(rule: ProcessRule, requested?: number): number | null {
  const candidate = requested ?? rule.defaultTimeoutMs;
  if (candidate === null || candidate === undefined) return null;
  return rule.maxTimeoutMs === null ? Math.max(1, candidate) : Math.max(1, Math.min(candidate, rule.maxTimeoutMs));
}

function formatMb(value: number): string {
  return (value / MiB).toFixed(0);
}

export class ProcessBudgetGovernor {
  readonly #active = new Map<string, ActiveLease>();
  readonly #pendingByKind = new Map<ProcessBudgetKind, number>();
  #pendingTotal = 0;
  #pendingReservedBytes = 0;
  #nextId = 0;

  constructor(
    private readonly maxActive = 7,
    private readonly readResources: () => Promise<ServiceResourceSnapshot> = resourceSnapshot,
  ) {}

  async acquire(kind: ProcessBudgetKind, requestedTimeoutMs?: number): Promise<ProcessBudgetLease> {
    const rule = RULES[kind];
    const sameKind = [...this.#active.values()].filter((entry) => entry.kind === kind).length + (this.#pendingByKind.get(kind) ?? 0);
    if (sameKind >= rule.maxConcurrent) throw this.#reject(kind, "category_limit", `maxConcurrent=${rule.maxConcurrent}`);

    const occupied = this.#active.size + this.#pendingTotal;
    if (kind !== "cleanup" && occupied >= this.maxActive) throw this.#reject(kind, "global_limit", `activeOrPending=${occupied} max=${this.maxActive}`);

    this.#pendingTotal += 1;
    this.#pendingReservedBytes += rule.reserveBytes;
    this.#pendingByKind.set(kind, (this.#pendingByKind.get(kind) ?? 0) + 1);

    let resources: ServiceResourceSnapshot;
    try {
      resources = await this.readResources();
      if (kind !== "cleanup" && resources.memoryLimitBytes) {
        const now = Date.now();
        const warmReservedBytes = [...this.#active.values()].reduce(
          (total, lease) => total + (lease.reserveUntil > now ? lease.reserveBytes : 0),
          0,
        );
        const currentPressure = resources.memoryUsedBytes / resources.memoryLimitBytes;
        const predictedPressure =
          (resources.memoryUsedBytes + warmReservedBytes + this.#pendingReservedBytes) /
          resources.memoryLimitBytes;
        if (predictedPressure >= rule.pressureCeiling) {
          throw this.#reject(
            kind,
            "memory_pressure",
            `usedMb=${formatMb(resources.memoryUsedBytes)} reserveMb=${formatMb(rule.reserveBytes)} limitMb=${formatMb(resources.memoryLimitBytes)} current=${(currentPressure * 100).toFixed(1)}% predicted=${(predictedPressure * 100).toFixed(1)}% ceiling=${(rule.pressureCeiling * 100).toFixed(1)}%`,
          );
        }
      }
    } catch (error) {
      this.#releasePending(kind, rule.reserveBytes);
      throw error;
    }

    this.#releasePending(kind, rule.reserveBytes);
    const id = `${process.pid}-${Date.now().toString(36)}-${++this.#nextId}`;
    const admittedAt = Date.now();
    const timeoutMs = clampTimeout(rule, requestedTimeoutMs);
    this.#active.set(id, {
      id,
      kind,
      admittedAt,
      reserveBytes: rule.reserveBytes,
      reserveUntil: admittedAt + RESERVATION_WARMUP_MS,
    });

    logger.info(
      `[ProcessBudget] admit kind=${kind} lease=${id} active=${this.#active.size}/${this.maxActive} workingSetMb=${formatMb(resources.memoryUsedBytes)} totalMb=${resources.memoryTotalBytes ? formatMb(resources.memoryTotalBytes) : "unknown"} memoryLimitMb=${resources.memoryLimitBytes ? formatMb(resources.memoryLimitBytes) : "unknown"} cpuLimit=${resources.cpuLimitCores?.toFixed(2) ?? "unknown"} timeoutMs=${timeoutMs ?? "owner-bound"}`,
    );

    let released = false;
    return {
      id,
      kind,
      admittedAt,
      timeoutMs,
      release: () => {
        if (released) return;
        released = true;
        this.#active.delete(id);
        logger.info(`[ProcessBudget] release kind=${kind} lease=${id} durationMs=${Date.now() - admittedAt} active=${this.#active.size}/${this.maxActive}`);
      },
    };
  }

  async snapshot(): Promise<ProcessBudgetSnapshot> {
    const [resources, cgroupProcs] = await Promise.all([
      this.readResources(),
      readText(CGROUP_PROCS),
    ]);
    const activeByKind: Record<string, number> = {};
    for (const lease of this.#active.values()) activeByKind[lease.kind] = (activeByKind[lease.kind] ?? 0) + 1;
    const serviceProcessCount = cgroupProcs
      ? cgroupProcs.split(/\r?\n/u).filter((line) => line.trim().length > 0).length
      : null;
    return { ...resources, activeCount: this.#active.size, activeByKind, serviceProcessCount };
  }

  rule(kind: ProcessBudgetKind): ProcessRule {
    return RULES[kind];
  }

  #releasePending(kind: ProcessBudgetKind, reserveBytes: number): void {
    this.#pendingTotal = Math.max(0, this.#pendingTotal - 1);
    this.#pendingReservedBytes = Math.max(0, this.#pendingReservedBytes - reserveBytes);
    const next = Math.max(0, (this.#pendingByKind.get(kind) ?? 0) - 1);
    if (next === 0) this.#pendingByKind.delete(kind);
    else this.#pendingByKind.set(kind, next);
  }

  #reject(kind: ProcessBudgetKind, reason: ProcessBudgetError["reason"], detail: string): ProcessBudgetError {
    const error = new ProcessBudgetError(kind, reason, `Process budget rejected ${kind}: ${detail}`);
    logger.warn(`[ProcessBudget] reject kind=${kind} reason=${reason} ${detail}`);
    return error;
  }
}

export const processBudget = new ProcessBudgetGovernor(
  Math.max(1, Number.parseInt(process.env.BOT_PROCESS_MAX_ACTIVE ?? "7", 10) || 7),
);

type BudgetExecOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  windowsHide?: boolean;
  maxBuffer?: number;
  encoding?: BufferEncoding;
  timeout?: number;
};

export async function budgetedExecFile(
  kind: ProcessBudgetKind,
  file: string,
  args: readonly string[],
  options: BudgetExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const lease = await processBudget.acquire(kind, options.timeout);
  try {
    const result = await execFileAsync(file, [...args], {
      ...options,
      env: childEnvironment(options.env ?? process.env),
      timeout: lease.timeoutMs ?? undefined,
      encoding: options.encoding ?? "utf8",
    });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  } finally {
    lease.release();
  }
}

export async function budgetedExec(
  kind: ProcessBudgetKind,
  command: string,
  options: BudgetExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const lease = await processBudget.acquire(kind, options.timeout);
  try {
    const result = await execAsync(command, {
      ...options,
      env: childEnvironment(options.env ?? process.env),
      timeout: lease.timeoutMs ?? undefined,
      encoding: options.encoding ?? "utf8",
    });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  } finally {
    lease.release();
  }
}

export async function budgetedSpawn(
  kind: ProcessBudgetKind,
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): Promise<ChildProcess> {
  const lease = await processBudget.acquire(kind);
  const rule = processBudget.rule(kind);
  let child: ChildProcess;
  try {
    child = spawn(command, [...args], {
      ...options,
      env: childEnvironment({
        ...process.env,
        ...(options.env ?? {}),
        BOT_PROCESS_BUDGET_KIND: kind,
        BOT_PROCESS_BUDGET_LEASE_ID: lease.id,
        ...(kind === "opencode-server"
          ? {
              OPENCODE_TELEGRAM_PROCESS_BUDGET: "1",
              OPENCODE_TELEGRAM_CHILD_MAX_ACTIVE:
                process.env.OPENCODE_TELEGRAM_CHILD_MAX_ACTIVE?.trim() || "4",
            }
          : {}),
      }),
    });
  } catch (error) {
    lease.release();
    throw error;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const finish = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    lease.release();
  };
  child.once("error", finish);
  child.once("exit", finish);
  child.once("close", finish);

  if (rule.maxLifetimeMs !== null) {
    timer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      logger.warn(`[ProcessBudget] lifetime_exceeded kind=${kind} lease=${lease.id} maxLifetimeMs=${rule.maxLifetimeMs}`);
      child.kill("SIGTERM");
      const force = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 2_000);
      force.unref?.();
    }, rule.maxLifetimeMs);
    timer.unref?.();
  }

  return child;
}

export async function getProcessBudgetSnapshot(): Promise<ProcessBudgetSnapshot> {
  return processBudget.snapshot();
}

export function getProcessRules(): Readonly<Record<ProcessBudgetKind, ProcessRule>> {
  return RULES;
}
