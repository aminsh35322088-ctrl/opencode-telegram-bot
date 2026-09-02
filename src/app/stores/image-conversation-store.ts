import path from "node:path";
import { getRuntimePaths } from "../../runtime/paths.js";
import { logger } from "../../utils/logger.js";

export interface SerializedImageConversationTurn {
  role: "user" | "assistant";
  content: string;
}

export interface SerializedImageConversationState {
  turns: SerializedImageConversationTurn[];
  currentImageBase64?: string;
  currentImageMimeType?: string;
  expiresAt: number;
  updatedAt: number;
}

interface ImageConversationStore {
  conversations: Record<string, SerializedImageConversationState>;
}

const STORE_FILENAME = "image-conversations.json";

function getStoreFilePath(): string {
  return path.join(getRuntimePaths().appHome, STORE_FILENAME);
}

function getStoreBackupFilePath(): string {
  return `${getStoreFilePath()}.bak`;
}

function getStoreTempFilePath(): string {
  return `${getStoreFilePath()}.tmp`;
}

let skipNextBackupRotation = false;

function isFileNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readStoreFileAt(filePath: string): Promise<ImageConversationStore> {
  const fs = await import("fs/promises");
  const content = await fs.readFile(filePath, "utf-8");
  const parsed = JSON.parse(content) as Partial<ImageConversationStore>;
  if (!parsed || typeof parsed !== "object" || !parsed.conversations || typeof parsed.conversations !== "object") {
    throw new Error(`Invalid image conversation store format: ${filePath}`);
  }
  return { conversations: parsed.conversations as Record<string, SerializedImageConversationState> };
}

async function readStoreFile(): Promise<ImageConversationStore> {
  const storeFilePath = getStoreFilePath();
  const backupFilePath = getStoreBackupFilePath();

  try {
    return await readStoreFileAt(storeFilePath);
  } catch (primaryError) {
    if (!isFileNotFound(primaryError)) {
      logger.warn(`[ImageConversationStore] Cannot read store file ${storeFilePath}:`, primaryError);
    }

    try {
      const backupStore = await readStoreFileAt(backupFilePath);
      logger.warn(`[ImageConversationStore] Recovered store from backup ${backupFilePath}`);
      skipNextBackupRotation = true;
      return backupStore;
    } catch (backupError) {
      if (isFileNotFound(primaryError) && isFileNotFound(backupError)) {
        return { conversations: {} };
      }

      logger.error(
        `[ImageConversationStore] Store file ${storeFilePath} and its backup ${backupFilePath} are both unusable.`,
        { primaryError, backupError },
      );
      throw new Error(
        `Cannot read image conversation store: ${storeFilePath} and its backup ${backupFilePath} are both unusable. ` +
          "Both files were left untouched - fix or remove them manually and start the bot again.",
      );
    }
  }
}

async function writeStoreFileAtomically(store: ImageConversationStore): Promise<void> {
  const fs = await import("fs/promises");
  const storeFilePath = getStoreFilePath();
  const tempFilePath = getStoreTempFilePath();

  await fs.mkdir(path.dirname(storeFilePath), { recursive: true });

  try {
    await fs.writeFile(tempFilePath, JSON.stringify(store, null, 2), { mode: 0o600 });

    if (!skipNextBackupRotation) {
      try {
        await fs.rename(storeFilePath, getStoreBackupFilePath());
      } catch (error) {
        if (!isFileNotFound(error)) {
          throw error;
        }
      }
    }

    await fs.rename(tempFilePath, storeFilePath);
    skipNextBackupRotation = false;
  } catch (error) {
    await fs.rm(tempFilePath, { force: true }).catch(() => {});
    throw error;
  }
}

let storeWriteQueue: Promise<void> = Promise.resolve();

function writeStoreFile(store: ImageConversationStore): Promise<void> {
  storeWriteQueue = storeWriteQueue
    .catch(() => undefined)
    .then(() => writeStoreFileAtomically(store));
  return storeWriteQueue;
}

let currentStore: ImageConversationStore = { conversations: {} };

export function flushImageConversationStore(): Promise<void> {
  return storeWriteQueue;
}

export async function loadImageConversationStore(): Promise<void> {
  currentStore = await readStoreFile();
  logger.info(`[ImageConversationStore] Loaded ${Object.keys(currentStore.conversations).length} conversations`);
}

export function getImageConversationState(
  chatId: number,
): SerializedImageConversationState | undefined {
  const key = String(chatId);
  const state = currentStore.conversations[key];
  if (!state) return undefined;
  if (state.expiresAt <= Date.now()) {
    delete currentStore.conversations[key];
    void writeStoreFile(currentStore).catch((error) => {
      logger.error(`[ImageConversationStore] Failed to persist expired conversation cleanup for chatId=${chatId}:`, error);
    });
    return undefined;
  }
  return state;
}

export function setImageConversationState(
  chatId: number,
  state: SerializedImageConversationState,
): Promise<void> {
  const key = String(chatId);
  currentStore.conversations[key] = { ...state, updatedAt: Date.now() };
  return writeStoreFile(currentStore);
}

export function deleteImageConversationState(chatId: number): Promise<void> {
  const key = String(chatId);
  delete currentStore.conversations[key];
  logger.info(`[ImageConversationStore] Deleted conversation for chatId=${chatId}`);
  return writeStoreFile(currentStore);
}

export function listImageConversationChatIds(): number[] {
  const now = Date.now();
  return Object.entries(currentStore.conversations)
    .filter(([, state]) => state.expiresAt > now)
    .map(([key]) => Number(key));
}

export function getAllImageConversationStates(): Map<number, SerializedImageConversationState> {
  const now = Date.now();
  const result = new Map<number, SerializedImageConversationState>();
  for (const [key, state] of Object.entries(currentStore.conversations)) {
    if (state.expiresAt > now) {
      result.set(Number(key), state);
    }
  }
  return result;
}

export function __resetImageConversationStoreForTests(): void {
  currentStore = { conversations: {} };
  storeWriteQueue = Promise.resolve();
  skipNextBackupRotation = false;
}

export async function __waitForImageConversationStoreWritesForTests(): Promise<void> {
  await storeWriteQueue;
}
