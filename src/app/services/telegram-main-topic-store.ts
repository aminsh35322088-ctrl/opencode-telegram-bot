import path from "node:path";
import { readFileSync } from "node:fs";
import { getRuntimePaths } from "../../runtime/paths.js";

export interface MainTopicBinding {
  chatId: number;
  threadId: number;
  title: string;
  createdAt: string;
}

type MainTopicStore = Record<string, MainTopicBinding>;

function getStorePath(): string {
  return path.join(path.dirname(getRuntimePaths().settingsFilePath), "telegram-main-topic.json");
}

function isFileNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function normalizeBinding(value: unknown, chatId: number): MainTopicBinding | null {
  if (!value || typeof value !== "object") return null;
  const binding = value as Partial<MainTopicBinding>;
  if (binding.chatId !== chatId || typeof binding.threadId !== "number") return null;
  return {
    chatId,
    threadId: binding.threadId,
    title: typeof binding.title === "string" ? binding.title : "General",
    createdAt: typeof binding.createdAt === "string" ? binding.createdAt : new Date(0).toISOString(),
  };
}

function parseStore(value: unknown): MainTopicStore {
  if (!value || typeof value !== "object") return {};
  const legacy = normalizeBinding(value, (value as Partial<MainTopicBinding>).chatId ?? 0);
  if (legacy) return { [String(legacy.chatId)]: legacy };

  const store: MainTopicStore = {};
  for (const [key, candidate] of Object.entries(value as Record<string, unknown>)) {
    const chatId = Number(key);
    const binding = normalizeBinding(candidate, chatId);
    if (binding) store[key] = binding;
  }
  return store;
}

async function readStore(): Promise<MainTopicStore> {
  const fs = await import("fs/promises");
  try {
    return parseStore(JSON.parse(await fs.readFile(getStorePath(), "utf8")));
  } catch (error) {
    if (isFileNotFound(error)) return {};
    throw error;
  }
}

function readStoreSync(): MainTopicStore {
  try {
    return parseStore(JSON.parse(readFileSync(getStorePath(), "utf8")));
  } catch (error) {
    if (isFileNotFound(error)) return {};
    throw error;
  }
}

export async function getMainTelegramTopic(chatId: number): Promise<MainTopicBinding | null> {
  return normalizeBinding((await readStore())[String(chatId)], chatId);
}

export function getMainTelegramTopicSync(chatId: number): MainTopicBinding | null {
  return normalizeBinding(readStoreSync()[String(chatId)], chatId);
}

export async function getMainTelegramThreadId(chatId: number): Promise<number | null> {
  return (await getMainTelegramTopic(chatId))?.threadId ?? null;
}

export function getMainTelegramThreadIdSync(chatId: number): number | null {
  return getMainTelegramTopicSync(chatId)?.threadId ?? null;
}

export async function isMainTelegramTopic(chatId: number, threadId: number | undefined | null): Promise<boolean> {
  if (typeof threadId !== "number") return false;
  return (await getMainTelegramThreadId(chatId)) === threadId;
}

export function isMainTelegramTopicSync(chatId: number, threadId: number | undefined | null): boolean {
  if (typeof threadId !== "number") return false;
  return getMainTelegramThreadIdSync(chatId) === threadId;
}

export async function saveMainTelegramTopic(chatId: number, threadId: number, title = "General"): Promise<void> {
  const fs = await import("fs/promises");
  const storePath = getStorePath();
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  const store = await readStore();
  store[String(chatId)] = {
    chatId,
    threadId,
    title,
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf8");
}
