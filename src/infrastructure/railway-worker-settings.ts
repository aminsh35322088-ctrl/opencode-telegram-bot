import { lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { syncDirectory } from "../utils/sync-directory.js";
import { isRestrictiveMode } from "../utils/file-ownership.js";
import { randomUUID } from "node:crypto";

export interface RailwayWorkerSettings {
  workerCreationEnabled: boolean;
  warmCapacity: number;
  workersPerProject: number;
}

export const DEFAULT_RAILWAY_WORKER_SETTINGS: RailwayWorkerSettings = {
  workerCreationEnabled: true,
  warmCapacity: 4,
  workersPerProject: 4,
};

function integer(value: unknown, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`Invalid Railway Worker setting: ${name}`);
  }
  return value as number;
}

export function normalizeRailwayWorkerSettings(value: unknown): RailwayWorkerSettings {
  if (value === undefined || value === null) return { ...DEFAULT_RAILWAY_WORKER_SETTINGS };
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Railway Worker settings");
  const candidate = value as Record<string, unknown>;
  for (const key of Object.keys(candidate)) {
    if (!(["workerCreationEnabled", "warmCapacity", "workersPerProject"] as const).includes(key as never)) {
      throw new Error(`Unknown Railway Worker setting: ${key}`);
    }
  }
  const workerCreationEnabled = candidate.workerCreationEnabled ?? DEFAULT_RAILWAY_WORKER_SETTINGS.workerCreationEnabled;
  if (typeof workerCreationEnabled !== "boolean") throw new Error("Invalid Railway Worker setting: workerCreationEnabled");
  return {
    workerCreationEnabled,
    warmCapacity: integer(candidate.warmCapacity ?? DEFAULT_RAILWAY_WORKER_SETTINGS.warmCapacity, 0, 4, "warmCapacity"),
    workersPerProject: integer(candidate.workersPerProject ?? DEFAULT_RAILWAY_WORKER_SETTINGS.workersPerProject, 1, 4, "workersPerProject"),
  };
}

export function applyRailwayWorkerSettingsPatch(current: RailwayWorkerSettings, patch: unknown): RailwayWorkerSettings {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Invalid Railway Worker settings patch");
  return normalizeRailwayWorkerSettings({ ...current, ...(patch as Record<string, unknown>) });
}

export class RailwayWorkerSettingsStore {
  private current: RailwayWorkerSettings | undefined;
  constructor(private readonly filename: string) {}

  async load(): Promise<RailwayWorkerSettings> {
    if (this.current) return { ...this.current };
    try {
      const stat = await lstat(this.filename);
      if (!stat.isFile() || stat.isSymbolicLink() || !isRestrictiveMode(stat.mode) || stat.size > 64 * 1024) throw new Error("Invalid Railway Worker settings store");
      const persisted=JSON.parse(await readFile(this.filename, "utf8")) as unknown;
      // Migrate older persisted policies that allowed five or more Workers.
      // Runtime settings updates still reject values above the hard four-Worker cap.
      if(persisted&&typeof persisted==="object"&&!Array.isArray(persisted)){
        const legacy=persisted as Record<string,unknown>;
        // The four-Worker policy is a hard operational cap and also the
        // required warm target, so migrate older lower or higher values to 4.
        this.current=normalizeRailwayWorkerSettings({...legacy,warmCapacity:4,workersPerProject:4});
        if(legacy.warmCapacity!==4||legacy.workersPerProject!==4)await this.save(this.current);
      }else this.current=normalizeRailwayWorkerSettings(persisted);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.current = { ...DEFAULT_RAILWAY_WORKER_SETTINGS };
      await this.save(this.current);
    }
    return { ...this.current };
  }

  async update(patch: unknown): Promise<RailwayWorkerSettings> {
    const next = applyRailwayWorkerSettingsPatch(await this.load(), patch);
    await this.save(next);
    this.current = next;
    return { ...next };
  }

  private async save(value: RailwayWorkerSettings): Promise<void> {
    const directory = path.dirname(this.filename);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, this.filename);
    await syncDirectory(directory);
  }
}
