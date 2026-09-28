import path from "node:path";
import { getRuntimePaths } from "../../runtime/paths.js";
import { logger } from "../../utils/logger.js";

export interface SubagentTopicBinding {
  chatId: number;
  threadId: number;
  parentSessionId: string;
  sessionId: string;
  directory: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  closed: boolean;
  paused: boolean;
  messageIds: number[];
  statusMessageId?: number;
}

function getStorePath(): string {
  return path.join(
    getRuntimePaths().appHome,
    "runtime",
    "topics",
    "subagent-topic-bindings.json",
  );
}

function isFileNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isBinding(value: unknown): value is SubagentTopicBinding {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SubagentTopicBinding>;
  return (
    typeof item.chatId === "number" &&
    typeof item.threadId === "number" &&
    typeof item.parentSessionId === "string" &&
    typeof item.sessionId === "string" &&
    typeof item.directory === "string" &&
    typeof item.title === "string" &&
    typeof item.createdAt === "string"
  );
}

function normalize(binding: SubagentTopicBinding): SubagentTopicBinding {
  return {
    ...binding,
    updatedAt: binding.updatedAt || binding.createdAt,
    closed: binding.closed ?? false,
    paused: binding.paused ?? false,
    messageIds: Array.isArray(binding.messageIds)
      ? binding.messageIds.filter((id) => Number.isSafeInteger(id) && id > 0)
      : [],
  };
}

async function readBindings(): Promise<SubagentTopicBinding[]> {
  const fs = await import("fs/promises");
  try {
    const raw = await fs.readFile(getStorePath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("Subagent topic binding store must contain an array");
    }
    return parsed.filter(isBinding).map(normalize);
  } catch (error) {
    if (isFileNotFound(error)) return [];
    logger.error("[SubagentTopics] Failed to read binding store:", error);
    throw error;
  }
}

let writeQueue: Promise<void> = Promise.resolve();

async function writeBindings(bindings: SubagentTopicBinding[]): Promise<void> {
  const fs = await import("fs/promises");
  const storePath = getStorePath();
  const tempPath = `${storePath}.tmp`;
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  try {
    await fs.writeFile(tempPath, JSON.stringify(bindings, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(tempPath, storePath);
    await fs.chmod(storePath, 0o600).catch(() => {});
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

async function mutate(
  mutator: (bindings: SubagentTopicBinding[]) => SubagentTopicBinding[],
): Promise<void> {
  const operation = writeQueue.catch(() => {}).then(async () => {
    const bindings = await readBindings();
    await writeBindings(mutator(bindings));
  });
  writeQueue = operation;
  await operation;
}

export async function listSubagentTopicBindings(): Promise<SubagentTopicBinding[]> {
  return readBindings();
}

export async function findSubagentTopicBySession(
  chatId: number,
  sessionId: string,
): Promise<SubagentTopicBinding | null> {
  return (
    (await readBindings()).find(
      (binding) => binding.chatId === chatId && binding.sessionId === sessionId,
    ) ?? null
  );
}

export async function findSubagentTopicByThread(
  chatId: number,
  threadId: number,
): Promise<SubagentTopicBinding | null> {
  return (
    (await readBindings()).find(
      (binding) => binding.chatId === chatId && binding.threadId === threadId,
    ) ?? null
  );
}

export async function findSubagentTopicsByParent(
  parentSessionId: string,
): Promise<SubagentTopicBinding[]> {
  return (await readBindings()).filter(
    (binding) => binding.parentSessionId === parentSessionId,
  );
}

export async function saveSubagentTopicBinding(
  binding: SubagentTopicBinding,
): Promise<void> {
  const normalized = normalize(binding);
  await mutate((bindings) => {
    const index = bindings.findIndex(
      (item) =>
        (item.chatId === normalized.chatId &&
          item.sessionId === normalized.sessionId) ||
        (item.chatId === normalized.chatId &&
          item.threadId === normalized.threadId),
    );
    if (index >= 0) bindings[index] = normalized;
    else bindings.push(normalized);
    return bindings;
  });
}

export async function updateSubagentTopicBinding(
  chatId: number,
  sessionId: string,
  patch: Partial<
    Pick<
      SubagentTopicBinding,
      | "title"
      | "closed"
      | "paused"
      | "messageIds"
      | "statusMessageId"
    >
  >,
): Promise<void> {
  await mutate((bindings) =>
    bindings.map((binding) =>
      binding.chatId === chatId && binding.sessionId === sessionId
        ? {
            ...binding,
            ...patch,
            updatedAt: new Date().toISOString(),
          }
        : binding,
    ),
  );
}
