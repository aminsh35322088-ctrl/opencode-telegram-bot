import path from "node:path";
import { getRuntimePaths } from "../../runtime/paths.js";
import { logger } from "../../utils/logger.js";

export type TelegramTopicMigrationStatus = "pending" | "migrating" | "completed" | "failed";

export interface TelegramTopicBinding {
  chatId: number;
  threadId: number;
  sessionId: string;
  directory: string;
  title: string;
  migrationStatus: TelegramTopicMigrationStatus;
  migrationCursor: number;
  createdAt: string;
  updatedAt: string;
  migratedAt?: string;
}

function getStorePath(): string {
  return path.join(path.dirname(getRuntimePaths().settingsFilePath), "telegram-topic-bindings.json");
}

function isFileNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readBindings(): Promise<TelegramTopicBinding[]> {
  const fs = await import("fs/promises");
  try {
    const raw = await fs.readFile(getStorePath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("Telegram topic binding store must contain an array");
    }
    return parsed.filter((item): item is TelegramTopicBinding => {
      if (!item || typeof item !== "object") return false;
      const value = item as Partial<TelegramTopicBinding>;
      return (
        typeof value.chatId === "number" &&
        typeof value.threadId === "number" &&
        typeof value.sessionId === "string" &&
        typeof value.directory === "string" &&
        typeof value.title === "string" &&
        (value.migrationStatus === "pending" ||
          value.migrationStatus === "migrating" ||
          value.migrationStatus === "completed" ||
          value.migrationStatus === "failed") &&
        typeof value.migrationCursor === "number" &&
        typeof value.createdAt === "string" &&
        typeof value.updatedAt === "string"
      );
    });
  } catch (error) {
    if (isFileNotFound(error)) return [];
    logger.error("[TelegramTopics] Failed to read topic binding store:", error);
    throw error;
  }
}

let writeQueue: Promise<void> = Promise.resolve();

async function writeBindings(bindings: TelegramTopicBinding[]): Promise<void> {
  const fs = await import("fs/promises");
  const storePath = getStorePath();
  const tempPath = `${storePath}.tmp`;
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  try {
    await fs.writeFile(tempPath, JSON.stringify(bindings, null, 2), "utf8");
    await fs.rename(tempPath, storePath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

function enqueueWrite(bindings: TelegramTopicBinding[]): Promise<void> {
  writeQueue = writeQueue.catch(() => {}).then(() => writeBindings(bindings));
  return writeQueue;
}

export async function listTelegramTopicBindings(): Promise<TelegramTopicBinding[]> {
  return readBindings();
}

export async function findTelegramTopicBindingBySession(
  chatId: number,
  sessionId: string,
): Promise<TelegramTopicBinding | null> {
  const bindings = await readBindings();
  return bindings.find((binding) => binding.chatId === chatId && binding.sessionId === sessionId) ?? null;
}

export async function findTelegramTopicBindingByThread(
  chatId: number,
  threadId: number,
): Promise<TelegramTopicBinding | null> {
  const bindings = await readBindings();
  return bindings.find((binding) => binding.chatId === chatId && binding.threadId === threadId) ?? null;
}

export async function saveTelegramTopicBinding(binding: TelegramTopicBinding): Promise<void> {
  const bindings = await readBindings();
  const index = bindings.findIndex(
    (item) =>
      (item.chatId === binding.chatId && item.sessionId === binding.sessionId) ||
      (item.chatId === binding.chatId && item.threadId === binding.threadId),
  );

  if (index >= 0) {
    bindings[index] = binding;
  } else {
    bindings.push(binding);
  }

  await enqueueWrite(bindings);
}

export async function updateTelegramTopicBinding(
  binding: TelegramTopicBinding,
  changes: Partial<TelegramTopicBinding>,
): Promise<TelegramTopicBinding> {
  const next: TelegramTopicBinding = {
    ...binding,
    ...changes,
    updatedAt: new Date().toISOString(),
  };
  await saveTelegramTopicBinding(next);
  return next;
}

export async function removeTelegramTopicBinding(chatId: number, sessionId: string): Promise<void> {
  const bindings = await readBindings();
  const filtered = bindings.filter(
    (binding) => !(binding.chatId === chatId && binding.sessionId === sessionId),
  );
  await enqueueWrite(filtered);
}
