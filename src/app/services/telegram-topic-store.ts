import { randomUUID } from "node:crypto";
import path from "node:path";
import { getRuntimePaths } from "../../runtime/paths.js";
import { logger } from "../../utils/logger.js";
import { topicTelemetry } from "../../utils/topic-observability.js";
import { normalizeTopicDirectory, type TopicBindingRef } from "./topic-worker-protocol.js";

export interface TelegramTopicBinding extends TopicBindingRef {
  createdAt: string;
  updatedAt: string;
  title?: string;
  navigationMessageId?: number;
}

export type TelegramTopicBindingInput = Omit<
  TelegramTopicBinding,
  "bindingId" | "bindingGeneration" | "updatedAt"
> &
  Partial<Pick<TelegramTopicBinding, "bindingId" | "bindingGeneration" | "updatedAt">>;

const DEFAULT_BINDING_GENERATION = 1;

function getStorePath(): string {
  return path.join(getRuntimePaths().appHome, "runtime", "topics", "telegram-topic-bindings.json");
}

function isFileNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function legacyBindingId(chatId: number, threadId: number): string {
  return `${chatId}:${threadId}`;
}

function routeKey(chatId: number, threadId: number): string {
  return `${chatId}:${threadId}`;
}

function parseBinding(value: unknown): TelegramTopicBinding | null {
  if (!isRecord(value)) return null;
  const chatId = value.chatId;
  const threadId = value.threadId;
  const sessionId = value.sessionId;
  const directory = value.directory;
  const createdAt = value.createdAt;
  const updatedAt = value.updatedAt;
  if (
    typeof chatId !== "number" ||
    !Number.isFinite(chatId) ||
    !Number.isInteger(chatId) ||
    chatId === 0 ||
    typeof threadId !== "number" ||
    !Number.isFinite(threadId) ||
    !Number.isInteger(threadId) ||
    threadId <= 0 ||
    !isNonEmptyString(sessionId) ||
    !isNonEmptyString(directory) ||
    !isNonEmptyString(createdAt) ||
    (updatedAt !== undefined && !isNonEmptyString(updatedAt))
  ) {
    return null;
  }

  const bindingId = value.bindingId === undefined || value.bindingId === null
    ? legacyBindingId(chatId, threadId)
    : value.bindingId;
  const bindingGeneration = value.bindingGeneration === undefined || value.bindingGeneration === null
    ? DEFAULT_BINDING_GENERATION
    : value.bindingGeneration;
  const effectiveUpdatedAt = updatedAt ?? createdAt;
  if (!isNonEmptyString(bindingId) || !isNonEmptyString(effectiveUpdatedAt)) return null;
  if (
    typeof bindingGeneration !== "number" ||
    !Number.isFinite(bindingGeneration) ||
    !Number.isInteger(bindingGeneration) ||
    bindingGeneration <= 0
  ) {
    return null;
  }

  const normalizedDirectory = normalizeTopicDirectory(directory);
  if (!normalizedDirectory) return null;
  const binding: TelegramTopicBinding = {
    bindingId,
    chatId,
    threadId,
    sessionId,
    directory: normalizedDirectory,
    bindingGeneration,
    createdAt,
    updatedAt: effectiveUpdatedAt,
  };
  if (value.title !== undefined) {
    if (typeof value.title !== "string") return null;
    binding.title = value.title;
  }
  if (value.navigationMessageId !== undefined) {
    if (typeof value.navigationMessageId !== "number" || !Number.isFinite(value.navigationMessageId)) return null;
    binding.navigationMessageId = value.navigationMessageId;
  }
  return binding;
}

function assertUniqueBindings(bindings: TelegramTopicBinding[]): void {
  const routes = new Set<string>();
  const sessions = new Set<string>();
  const bindingIds = new Set<string>();
  for (const binding of bindings) {
    const route = routeKey(binding.chatId, binding.threadId);
    if (routes.has(route)) throw new Error(`Duplicate Telegram Topic binding for chat/thread ${route}.`);
    if (sessions.has(binding.sessionId)) throw new Error(`Duplicate session ID for Telegram Topic binding ${binding.sessionId}.`);
    if (bindingIds.has(binding.bindingId)) throw new Error(`Duplicate Telegram Topic binding ID ${binding.bindingId}.`);
    routes.add(route);
    sessions.add(binding.sessionId);
    bindingIds.add(binding.bindingId);
  }
}

async function readBindings(): Promise<TelegramTopicBinding[]> {
  const fs = await import("fs/promises");
  try {
    const raw = await fs.readFile(getStorePath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("Telegram topic binding store must contain an array");
    const bindings = parsed.map(parseBinding).filter((binding): binding is TelegramTopicBinding => binding !== null);
    assertUniqueBindings(bindings);
    return bindings;
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
    await fs.writeFile(tempPath, JSON.stringify(bindings, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.chmod(tempPath, 0o600).catch(() => {});
    await fs.rename(tempPath, storePath);
    await fs.chmod(storePath, 0o600).catch(() => {});
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

interface BindingMutation<T> {
  bindings: TelegramTopicBinding[];
  result: T;
}

async function mutateBindings<T>(
  mutator: (bindings: TelegramTopicBinding[]) => BindingMutation<T> | Promise<BindingMutation<T>>,
): Promise<T> {
  const operation = writeQueue.catch(() => {}).then(async () => {
    const bindings = await readBindings();
    const mutation = await mutator(bindings);
    assertUniqueBindings(mutation.bindings);
    await writeBindings(mutation.bindings);
    return mutation.result;
  });
  writeQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function validateInput(binding: TelegramTopicBindingInput): void {
  if (!Number.isFinite(binding.chatId) || !Number.isInteger(binding.chatId) || binding.chatId === 0) {
    throw new Error("Telegram Topic binding chatId must be an integer.");
  }
  if (!Number.isFinite(binding.threadId) || !Number.isInteger(binding.threadId) || binding.threadId <= 0) {
    throw new Error("Telegram Topic binding threadId must be positive.");
  }
  if (!isNonEmptyString(binding.sessionId)) {
    throw new Error("Telegram Topic binding sessionId is required.");
  }
  if (!isNonEmptyString(binding.directory) || !normalizeTopicDirectory(binding.directory)) {
    throw new Error("Telegram Topic binding directory is required.");
  }
  if (binding.bindingId !== undefined && !isNonEmptyString(binding.bindingId)) {
    throw new Error("Telegram Topic binding ID is required.");
  }
  if (
    binding.bindingGeneration !== undefined &&
    (typeof binding.bindingGeneration !== "number" ||
      !Number.isFinite(binding.bindingGeneration) ||
      !Number.isInteger(binding.bindingGeneration) ||
      binding.bindingGeneration <= 0)
  ) {
    throw new Error("Telegram Topic binding generation must be positive.");
  }
  if (!isNonEmptyString(binding.createdAt)) {
    throw new Error("Telegram Topic binding createdAt is required.");
  }
  if (binding.updatedAt !== undefined && !isNonEmptyString(binding.updatedAt)) {
    throw new Error("Telegram Topic binding updatedAt is invalid.");
  }
}

function normalizedBindingInput(binding: TelegramTopicBindingInput, now: string): TelegramTopicBinding {
  const result: TelegramTopicBinding = {
    bindingId: binding.bindingId?.trim() ?? randomUUID(),
    chatId: binding.chatId,
    threadId: binding.threadId,
    sessionId: binding.sessionId,
    directory: normalizeTopicDirectory(binding.directory),
    bindingGeneration: binding.bindingGeneration ?? DEFAULT_BINDING_GENERATION,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt ?? now,
  };
  if (binding.title !== undefined) result.title = binding.title;
  if (binding.navigationMessageId !== undefined) result.navigationMessageId = binding.navigationMessageId;
  return result;
}

function mergeBinding(existing: TelegramTopicBinding, candidate: TelegramTopicBinding): TelegramTopicBinding {
  return {
    ...existing,
    ...candidate,
    bindingId: existing.bindingId,
    bindingGeneration: existing.bindingGeneration,
    createdAt: existing.createdAt,
    ...(candidate.title === undefined ? { title: existing.title } : {}),
    ...(candidate.navigationMessageId === undefined
      ? { navigationMessageId: existing.navigationMessageId }
      : {}),
  };
}

function findUnique<T>(values: T[], description: string): T | null {
  if (values.length > 1) throw new Error(`Ambiguous Telegram Topic binding lookup: ${description}.`);
  return values[0] ?? null;
}

export async function listTelegramTopicBindings(): Promise<TelegramTopicBinding[]> {
  return readBindings();
}

export async function findTelegramTopicBindingBySession(chatId: number, sessionId: string): Promise<TelegramTopicBinding | null> {
  return findUnique(
    (await readBindings()).filter((binding) => binding.chatId === chatId && binding.sessionId === sessionId),
    `chat ${chatId}, session ${sessionId}`,
  );
}

export async function findTelegramTopicBindingBySessionId(sessionId: string): Promise<TelegramTopicBinding | null> {
  return findUnique(
    (await readBindings()).filter((binding) => binding.sessionId === sessionId),
    `session ${sessionId}`,
  );
}

export async function findTelegramTopicBindingByThread(chatId: number, threadId: number): Promise<TelegramTopicBinding | null> {
  return findUnique(
    (await readBindings()).filter((binding) => binding.chatId === chatId && binding.threadId === threadId),
    `chat/thread ${routeKey(chatId, threadId)}`,
  );
}

export async function findTelegramTopicBindingByDirectory(directory: string): Promise<TelegramTopicBinding | null> {
  const normalized = normalizeTopicDirectory(directory);
  return findUnique(
    (await readBindings()).filter((binding) => binding.directory === normalized),
    `directory ${normalized}`,
  );
}

export async function findTelegramTopicBindingsByDirectory(directory: string): Promise<TelegramTopicBinding[]> {
  const normalized = normalizeTopicDirectory(directory);
  return (await readBindings()).filter((binding) => binding.directory === normalized);
}

export async function saveTelegramTopicBinding(binding: TelegramTopicBindingInput): Promise<void> {
  validateInput(binding);
  const now = new Date().toISOString();
  const candidate = normalizedBindingInput(binding, now);
  const saved = await mutateBindings((bindings) => {
    const routeIndex = bindings.findIndex(
      (item) => item.chatId === candidate.chatId && item.threadId === candidate.threadId,
    );
    const sessionIndex = bindings.findIndex((item) => item.sessionId === candidate.sessionId);
    const bindingIdIndex = bindings.findIndex((item) => item.bindingId === candidate.bindingId);
    if (sessionIndex >= 0 && sessionIndex !== routeIndex) {
      throw new Error(`Duplicate session ID for Telegram Topic binding ${candidate.sessionId}.`);
    }
    if (routeIndex >= 0) {
      const existing = bindings[routeIndex];
      if (!existing) throw new Error("Telegram Topic binding disappeared during save.");
      if (existing.sessionId !== candidate.sessionId) {
        throw new Error(`Duplicate Telegram Topic chat/thread ${routeKey(candidate.chatId, candidate.threadId)}.`);
      }
    }
    if (bindingIdIndex >= 0 && bindingIdIndex !== routeIndex) {
      throw new Error(`Duplicate Telegram Topic binding ID ${candidate.bindingId}.`);
    }
    if (routeIndex >= 0) {
      const existing = bindings[routeIndex];
      if (!existing) throw new Error("Telegram Topic binding disappeared during save.");
      if (binding.bindingId !== undefined && binding.bindingId.trim() !== existing.bindingId) {
        throw new Error(`Telegram Topic binding ID ${existing.bindingId} is already assigned to another identity.`);
      }
      const saved = mergeBinding(existing, candidate);
      const next = [...bindings];
      next[routeIndex] = saved;
      return { bindings: next, result: saved };
    }
    const next = [...bindings, candidate];
    return { bindings: next, result: candidate };
  });
  topicTelemetry("binding_saved", {
    chatId: saved.chatId,
    threadId: saved.threadId,
    sessionId: saved.sessionId,
    directory: saved.directory,
  });
}

export async function updateTelegramTopicBinding(
  chatId: number,
  threadId: number,
  patch: Partial<Pick<TelegramTopicBinding, "title" | "directory" | "sessionId" | "navigationMessageId">>,
): Promise<void> {
  if (patch.sessionId !== undefined && !isNonEmptyString(patch.sessionId)) {
    throw new Error("Telegram Topic binding sessionId is required.");
  }
  if (patch.directory !== undefined && !normalizeTopicDirectory(patch.directory)) {
    throw new Error("Telegram Topic binding directory is required.");
  }
  await mutateBindings((bindings) => {
    const index = bindings.findIndex((binding) => binding.chatId === chatId && binding.threadId === threadId);
    const existing = bindings[index];
    if (!existing) throw new Error(`Telegram Topic binding ${routeKey(chatId, threadId)} was not found.`);
    if (patch.sessionId !== undefined && patch.sessionId !== existing.sessionId) {
      const duplicate = bindings.some(
        (binding, bindingIndex) => bindingIndex !== index && binding.sessionId === patch.sessionId,
      );
      if (duplicate) throw new Error(`Duplicate session ID for Telegram Topic binding ${patch.sessionId}.`);
    }
    const updated: TelegramTopicBinding = {
      ...existing,
      ...patch,
      directory: patch.directory === undefined ? existing.directory : normalizeTopicDirectory(patch.directory),
      updatedAt: new Date().toISOString(),
    };
    const next = [...bindings];
    next[index] = updated;
    return { bindings: next, result: undefined };
  });
  topicTelemetry("binding_updated", {
    chatId,
    threadId,
    sessionId: patch.sessionId,
    directory: patch.directory === undefined ? undefined : normalizeTopicDirectory(patch.directory),
  });
}

export async function removeTelegramTopicBinding(chatId: number, sessionId: string): Promise<void> {
  await mutateBindings((bindings) => ({
    bindings: bindings.filter((binding) => !(binding.chatId === chatId && binding.sessionId === sessionId)),
    result: undefined,
  }));
  topicTelemetry("binding_removed", { chatId, sessionId });
}
