import fs from "node:fs/promises";
import path from "node:path";
import { getRuntimePaths } from "../../runtime/paths.js";
import { logger } from "../../utils/logger.js";

export interface AppState {
  version: 2;
  settings?: Record<string, unknown>;
  modelPreferences?: Record<string, unknown>;
  customProviders?: Record<string, unknown>;
  imageAi?: Record<string, unknown>;
  integrations?: Record<string, unknown>;
  aiRoles?: Record<string, unknown>;
  [key: string]: unknown;
}

const APP_STATE_FILENAME = "app-state.json";
const APP_STATE_BACKUP_FILENAME = "app-state.json.bak";
const APP_STATE_TEMP_SUFFIX = ".tmp";
let writeQueue: Promise<void> = Promise.resolve();
let initialized = false;

function getStatePath(): string { return path.join(getRuntimePaths().appHome, APP_STATE_FILENAME); }
function getBackupPath(): string { return path.join(getRuntimePaths().appHome, APP_STATE_BACKUP_FILENAME); }
function isNotFound(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
function normalizeState(value: unknown): AppState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { version: 2 };
  return { ...(value as Record<string, unknown>), version: 2 } as AppState;
}
async function readJson(filePath: string): Promise<AppState> { return normalizeState(JSON.parse(await fs.readFile(filePath, "utf8"))); }
async function readCurrentState(): Promise<AppState> {
  const statePath = getStatePath();
  try { return await readJson(statePath); }
  catch (primaryError) {
    if (!isNotFound(primaryError)) logger.warn(`[AppState] Cannot read ${statePath}; trying backup`, primaryError);
    try { return await readJson(getBackupPath()); }
    catch (backupError) {
      if (isNotFound(primaryError) && isNotFound(backupError)) return { version: 2 };
      logger.error(`[AppState] App state and backup are unusable: ${statePath}`, { primaryError, backupError });
      throw new Error(`Cannot read app state: ${statePath} and ${getBackupPath()} are both unusable.`);
    }
  }
}
export async function readAppState(): Promise<AppState> { const state = await readCurrentState(); initialized = true; return state; }
async function writeAppStateAtomically(state: AppState): Promise<void> {
  const appHome = getRuntimePaths().appHome;
  const statePath = getStatePath();
  const backupPath = getBackupPath();
  const tempPath = `${statePath}${APP_STATE_TEMP_SUFFIX}`;
  await fs.mkdir(appHome, { recursive: true });
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(normalizeState(state), null, 2)}\n`, { mode: 0o600 });
    try { await fs.rename(statePath, backupPath); } catch (error) { if (!isNotFound(error)) throw error; }
    await fs.rename(tempPath, statePath);
    await fs.chmod(statePath, 0o600).catch(() => {});
    initialized = true;
  } finally { await fs.rm(tempPath, { force: true }).catch(() => {}); }
}
export function updateAppState(patch: Record<string, unknown>): Promise<void> {
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    const previous = await readCurrentState();
    try { await writeAppStateAtomically({ ...previous, ...patch } as AppState); }
    catch (error) { logger.error("[AppState] Failed to persist application state:", error); throw error; }
  });
  return writeQueue;
}
export function writeAppState(nextState: AppState): Promise<void> {
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    try { await writeAppStateAtomically(normalizeState(nextState)); }
    catch (error) { logger.error("[AppState] Failed to persist application state:", error); throw error; }
  });
  return writeQueue;
}
export function clearAppState(): Promise<void> { return writeAppState({ version: 2 }); }
export function flushAppState(): Promise<void> { return writeQueue; }
export function getAppStatePath(): string { return getStatePath(); }
export function hasAppStateFile(): boolean { return initialized; }