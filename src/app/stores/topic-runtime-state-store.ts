import path from "node:path";
import { getRuntimePaths } from "../../runtime/paths.js";
import type { ModelInfo } from "../types/model.js";
import type { SessionInfo } from "../types/session.js";

export interface TopicRuntimeState {
  chatId: number;
  threadId: number;
  session?: SessionInfo;
  model?: ModelInfo;
  agent?: string;
  compactOutputMode?: boolean;
  updatedAt: string;
}

const states = new Map<string, TopicRuntimeState>();
let loaded = false;
let loadPromise: Promise<void> | null = null;
let writeQueue: Promise<void> = Promise.resolve();

function key(chatId: number, threadId: number): string {
  return `${chatId}:${threadId}`;
}

function storePath(): string {
  return path.join(path.dirname(getRuntimePaths().settingsFilePath), "telegram-topic-runtime.json");
}

function clone(state: TopicRuntimeState): TopicRuntimeState {
  return {
    ...state,
    session: state.session ? { ...state.session } : undefined,
    model: state.model ? { ...state.model } : undefined,
  };
}

async function persist(): Promise<void> {
  const fs = await import("fs/promises");
  const target = storePath();
  const temp = `${target}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temp, JSON.stringify([...states.values()], null, 2), "utf8");
  await fs.rename(temp, target);
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const fs = await import("fs/promises");
    try {
      const raw = await fs.readFile(storePath(), "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const value of parsed) {
          if (!value || typeof value !== "object") continue;
          const candidate = value as Partial<TopicRuntimeState>;
          if (
            typeof candidate.chatId !== "number" ||
            typeof candidate.threadId !== "number" ||
            typeof candidate.updatedAt !== "string"
          ) continue;
          states.set(key(candidate.chatId, candidate.threadId), clone(candidate as TopicRuntimeState));
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      loaded = true;
      loadPromise = null;
    }
  })();
  return loadPromise;
}

async function mutate(mutator: () => void): Promise<void> {
  await ensureLoaded();
  const operation = writeQueue.catch(() => {}).then(async () => {
    mutator();
    await persist();
  });
  writeQueue = operation;
  await operation;
}

export async function initializeTopicRuntimeState(
  chatId: number,
  threadId: number,
  defaults?: Partial<Pick<TopicRuntimeState, "session" | "model" | "agent" | "compactOutputMode">>,
): Promise<TopicRuntimeState> {
  await ensureLoaded();
  const existing = states.get(key(chatId, threadId));
  if (existing) return clone(existing);
  const created: TopicRuntimeState = {
    chatId,
    threadId,
    session: defaults?.session ? { ...defaults.session } : undefined,
    model: defaults?.model ? { ...defaults.model } : undefined,
    agent: defaults?.agent,
    compactOutputMode: defaults?.compactOutputMode,
    updatedAt: new Date().toISOString(),
  };
  await mutate(() => {
    states.set(key(chatId, threadId), created);
  });
  return clone(created);
}

export async function getTopicRuntimeState(chatId: number, threadId: number): Promise<TopicRuntimeState | null> {
  await ensureLoaded();
  const state = states.get(key(chatId, threadId));
  return state ? clone(state) : null;
}

export function getTopicRuntimeStateSync(chatId: number, threadId: number): TopicRuntimeState | null {
  const state = states.get(key(chatId, threadId));
  return state ? clone(state) : null;
}

export async function updateTopicRuntimeState(
  chatId: number,
  threadId: number,
  patch: Partial<Pick<TopicRuntimeState, "session" | "model" | "agent" | "compactOutputMode">>,
): Promise<TopicRuntimeState> {
  await ensureLoaded();
  let next: TopicRuntimeState | undefined;
  await mutate(() => {
    const previous = states.get(key(chatId, threadId)) ?? { chatId, threadId, updatedAt: new Date().toISOString() };
    next = {
      ...previous,
      ...patch,
      session: patch.session === undefined ? previous.session : patch.session ? { ...patch.session } : undefined,
      model: patch.model === undefined ? previous.model : patch.model ? { ...patch.model } : undefined,
      updatedAt: new Date().toISOString(),
    };
    states.set(key(chatId, threadId), next);
  });
  return clone(next!);
}

export async function removeTopicRuntimeState(chatId: number, threadId: number): Promise<void> {
  await ensureLoaded();
  await mutate(() => {
    states.delete(key(chatId, threadId));
  });
}

export async function listTopicRuntimeStates(): Promise<TopicRuntimeState[]> {
  await ensureLoaded();
  return [...states.values()].map(clone);
}
