import fs from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  revisionAppState,
  broadcastGlobalRevision,
  validateGlobalSnapshot,
  type GlobalMutationInput,
  type GlobalSnapshot,
} from "../../control-plane/global-state.js";
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
  mcpCredentials?: Record<string, unknown>;
  mcpServers?: Record<string, unknown>;
  aiRoles?: Record<string, unknown>;
  [key: string]: unknown;
}

const APP_STATE_FILENAME = "app-state.json";
const APP_STATE_BACKUP_FILENAME = "app-state.json.bak";
const APP_STATE_TEMP_SUFFIX = ".tmp";
let writeQueue: Promise<void> = Promise.resolve();
const transaction = new AsyncLocalStorage<{ state: AppState }>();
/** Internal writers may join the canonical queue without creating a nested transaction. */
export function isAppStateTransactionActive(): boolean { return Boolean(transaction.getStore()); }

function getStatePath(): string {
  return path.join(getRuntimePaths().appHome, APP_STATE_FILENAME);
}
function getBackupPath(): string {
  return path.join(getRuntimePaths().appHome, APP_STATE_BACKUP_FILENAME);
}
function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
function normalizeState(value: unknown): AppState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid application state");
  validateGlobalSnapshot((value as AppState).globalSnapshot);
  return { ...(value as Record<string, unknown>), version: 2 } as AppState;
}
async function readJson(filePath: string): Promise<AppState> {
  return normalizeState(JSON.parse(await fs.readFile(filePath, "utf8")));
}
async function readCurrentState(): Promise<AppState> {
  const statePath = getStatePath();
  try {
    return await readJson(statePath);
  } catch (primaryError) {
    if (!isNotFound(primaryError))
      logger.warn(`[AppState] Cannot read ${statePath}; trying backup`, primaryError);
    try {
      return await readJson(getBackupPath());
    } catch (backupError) {
      if (isNotFound(primaryError) && isNotFound(backupError)) return { version: 2 };
      logger.error(`[AppState] App state and backup are unusable: ${statePath}`, {
        primaryError,
        backupError,
      });
      throw new Error(
        `Cannot read app state: ${statePath} and ${getBackupPath()} are both unusable.`,
      );
    }
  }
}
export async function readAppState(): Promise<AppState> {
  const active = transaction.getStore();
  if (active) return structuredClone(active.state);
  await writeQueue.catch(() => {});
  return await readCurrentState();
}
async function writeAppStateAtomically(state: AppState): Promise<void> {
  const appHome = getRuntimePaths().appHome;
  const statePath = getStatePath();
  const backupPath = getBackupPath();
  const tempPath = `${statePath}${APP_STATE_TEMP_SUFFIX}`;
  await fs.mkdir(appHome, { recursive: true });
  try {
    const temporary = await fs.open(tempPath, "w", 0o600);
    try {
      await temporary.writeFile(`${JSON.stringify(normalizeState(state), null, 2)}\n`);
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    try {
      await fs.copyFile(statePath, backupPath);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    await fs.rename(tempPath, statePath);
    await fs.chmod(statePath, 0o600).catch(() => {});
    if (process.platform !== "win32") {
      const directory = await fs.open(appHome, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}
export function updateAppState(
  patch: Record<string, unknown> | ((state: AppState) => Record<string, unknown>),
): Promise<void> {
  const active = transaction.getStore();
  if (active) {
    active.state = {
      ...active.state,
      ...(typeof patch === "function" ? patch(structuredClone(active.state)) : patch),
    };
    return Promise.resolve();
  }
  return transactAppState(async () => {
    await updateAppState(patch);
  }).then(() => {});
}
export function writeAppState(nextState: AppState): Promise<void> {
  const active = transaction.getStore();
  if (active) {
    active.state = normalizeState(nextState);
    return Promise.resolve();
  }
  return transactAppState(async () => {
    await writeAppState(nextState);
  }).then(() => {});
}
/** The existing persistence queue is the sole serialization and atomic commit boundary. */
export function transactAppState(
  apply: () => Promise<void>,
  input?: GlobalMutationInput,
): Promise<GlobalSnapshot> {
  if (transaction.getStore()) throw new Error("Nested Global transactions are not supported");
  const result = writeQueue
    .catch(() => {})
    .then(async () => {
      const previous = await readCurrentState();
      const receipts = previous.globalMutationReceipts as Record<string, unknown> | undefined;
      if (input?.approvalId && receipts?.[input.approvalId])
        return structuredClone(validateGlobalSnapshot(previous.globalSnapshot)!);
      const active = { state: structuredClone(previous) };
      await transaction.run(active, apply);
      let next = await revisionAppState(previous, active.state);
      if (input?.approvalId)
        next = {
          ...next,
          globalMutationReceipts: {
            ...receipts,
            [input.approvalId]: {
              type: input.type,
              resource: input.resource,
              actorTopicId: input.actorTopicId,
              sessionId: input.sessionId,
              configHash: input.configHash,
              revision: (next.globalSnapshot as GlobalSnapshot).revision,
              ...(input.receipt ? { receipt: input.receipt } : {}),
            },
          },
        };
      if (JSON.stringify(previous) !== JSON.stringify(next)) await writeAppStateAtomically(next);
      return {
        previous,
        next,
        snapshot: structuredClone(validateGlobalSnapshot(next.globalSnapshot)!),
      };
    });
  writeQueue = result.then(() => {});
  void writeQueue.catch(() => {});
  // Notify after releasing the queue, so subscribers can read state or reconcile safely.
  return result.then(async (result) => {
    if ("snapshot" in result) {
      await broadcastGlobalRevision(result.previous, result.next);
      return result.snapshot;
    }
    return result;
  });
}
export function flushAppState(): Promise<void> {
  return writeQueue;
}
export function getAppStatePath(): string {
  return getStatePath();
}
