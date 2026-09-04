import path from "node:path";
import { getRuntimePaths } from "../../runtime/paths.js";
import { logger } from "../../utils/logger.js";

export interface TelegramTopicBinding {
  chatId: number;
  threadId: number;
  sessionId: string;
  directory: string;
  createdAt: string;
  updatedAt: string;
  title?: string;
}
function getStorePath(): string { return path.join(path.dirname(getRuntimePaths().settingsFilePath), "telegram-topic-bindings.json"); }
function isFileNotFound(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
async function readBindings(): Promise<TelegramTopicBinding[]> {
  const fs = await import("fs/promises");
  try { const raw = await fs.readFile(getStorePath(), "utf8"); const parsed: unknown = JSON.parse(raw); if (!Array.isArray(parsed)) throw new Error("Telegram topic binding store must contain an array"); return parsed.filter((item): item is TelegramTopicBinding => { if (!item || typeof item !== "object") return false; const value = item as Partial<TelegramTopicBinding>; return typeof value.chatId === "number" && typeof value.threadId === "number" && typeof value.sessionId === "string" && typeof value.directory === "string" && typeof value.createdAt === "string" && (value.updatedAt === undefined || typeof value.updatedAt === "string") && (value.title === undefined || typeof value.title === "string"); }).map((binding) => ({ ...binding, updatedAt: binding.updatedAt ?? binding.createdAt })); }
  catch (error) { if (isFileNotFound(error)) return []; logger.error("[TelegramTopics] Failed to read topic binding store:", error); throw error; }
}
let writeQueue: Promise<void> = Promise.resolve();
async function writeBindings(bindings: TelegramTopicBinding[]): Promise<void> { const fs = await import("fs/promises"); const storePath = getStorePath(); const tempPath = `${storePath}.tmp`; await fs.mkdir(path.dirname(storePath), { recursive: true }); try { await fs.writeFile(tempPath, JSON.stringify(bindings, null, 2), "utf8"); await fs.rename(tempPath, storePath); } finally { await fs.rm(tempPath, { force: true }).catch(() => {}); } }
async function mutateBindings(mutator: (bindings: TelegramTopicBinding[]) => TelegramTopicBinding[]): Promise<void> { const operation = writeQueue.catch(() => {}).then(async () => { const bindings = await readBindings(); await writeBindings(mutator(bindings)); }); writeQueue = operation; await operation; }
export async function listTelegramTopicBindings(): Promise<TelegramTopicBinding[]> { return readBindings(); }
export async function findTelegramTopicBindingBySession(chatId: number, sessionId: string): Promise<TelegramTopicBinding | null> { return (await readBindings()).find((binding) => binding.chatId === chatId && binding.sessionId === sessionId) ?? null; }
export async function findTelegramTopicBindingByThread(chatId: number, threadId: number): Promise<TelegramTopicBinding | null> { return (await readBindings()).find((binding) => binding.chatId === chatId && binding.threadId === threadId) ?? null; }
export async function findTelegramTopicBindingByDirectory(directory: string): Promise<TelegramTopicBinding | null> { return (await readBindings()).find((binding) => binding.directory === directory) ?? null; }
export async function saveTelegramTopicBinding(binding: TelegramTopicBinding): Promise<void> { const normalized = { ...binding, updatedAt: binding.updatedAt || new Date().toISOString() }; await mutateBindings((bindings) => { const index = bindings.findIndex((item) => (item.chatId === normalized.chatId && item.sessionId === normalized.sessionId) || (item.chatId === normalized.chatId && item.threadId === normalized.threadId)); if (index >= 0) bindings[index] = { ...bindings[index], ...normalized }; else bindings.push(normalized); return bindings; }); }
export async function updateTelegramTopicBinding(chatId: number, threadId: number, patch: Partial<Pick<TelegramTopicBinding, "title" | "directory" | "sessionId">>): Promise<void> { await mutateBindings((bindings) => bindings.map((binding) => binding.chatId === chatId && binding.threadId === threadId ? { ...binding, ...patch, updatedAt: new Date().toISOString() } : binding)); }
export async function removeTelegramTopicBinding(chatId: number, sessionId: string): Promise<void> { await mutateBindings((bindings) => bindings.filter((binding) => !(binding.chatId === chatId && binding.sessionId === sessionId))); }
