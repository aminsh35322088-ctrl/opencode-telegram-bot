import path from "node:path";
import { getRuntimePaths } from "../../runtime/paths.js";
import type { ModelInfo } from "../types/model.js";
import type { SessionInfo } from "../types/session.js";
import type { MessageFormatMode, ResponseStreamingMode } from "../types/settings.js";
import type { TopicDefaults, TopicRunState, TopicSettings } from "../types/topic-settings.js";

export interface TopicRuntimeState {
  chatId: number;
  threadId: number;
  /** Canonical per-Topic settings/state. */
  settings: TopicSettings;
  /** @deprecated Read/write through settings in new code. Kept for migration. */
  session?: SessionInfo;
  /** @deprecated Read/write through settings in new code. Kept for migration. */
  model?: ModelInfo;
  /** @deprecated Read/write through settings in new code. Kept for migration. */
  agent?: string;
  /** @deprecated Read/write through settings in new code. Kept for migration. */
  compactOutputMode?: boolean;
  updatedAt: string;
}

const DEFAULT_TOPIC_DEFAULTS: TopicDefaults = {
  compactOutputMode: false,
  showThinkingContent: true,
  responseStreamingMode: "edit",
  messageFormatMode: "markdown",
  showAssistantRunFooter: true,
  sendDiffFileAttachments: true,
  promptQueueEnabled: false,
  variant: undefined,
};

const states = new Map<string, TopicRuntimeState>();
let loaded = false;
let loadPromise: Promise<void> | null = null;
let writeQueue: Promise<void> = Promise.resolve();
function key(chatId: number, threadId: number): string { return `${chatId}:${threadId}`; }
function storePath(): string { return path.join(path.dirname(getRuntimePaths().settingsFilePath), "telegram-topic-runtime.json"); }

function cloneSettings(settings: TopicSettings): TopicSettings {
  return {
    ...settings,
    session: settings.session ? { ...settings.session } : undefined,
    model: settings.model ? { ...settings.model } : undefined,
  };
}

function clone(state: TopicRuntimeState): TopicRuntimeState {
  return {
    ...state,
    settings: cloneSettings(state.settings),
    session: state.session ? { ...state.session } : undefined,
    model: state.model ? { ...state.model } : undefined,
  };
}

function migrateLegacyState(value: Partial<TopicRuntimeState>): TopicSettings {
  const legacy = value.settings;
  const settings = legacy && typeof legacy === "object"
    ? cloneSettings(legacy)
    : {
        ...DEFAULT_TOPIC_DEFAULTS,
        session: value.session,
        model: value.model,
        agent: value.agent,
        compactOutputMode: value.compactOutputMode ?? DEFAULT_TOPIC_DEFAULTS.compactOutputMode,
        runState: "idle" as TopicRunState,
        updatedAt: value.updatedAt ?? new Date().toISOString(),
      };

  return {
    ...DEFAULT_TOPIC_DEFAULTS,
    ...settings,
    compactOutputMode: settings.compactOutputMode ?? DEFAULT_TOPIC_DEFAULTS.compactOutputMode,
    showThinkingContent: settings.showThinkingContent ?? DEFAULT_TOPIC_DEFAULTS.showThinkingContent,
    responseStreamingMode: settings.responseStreamingMode ?? DEFAULT_TOPIC_DEFAULTS.responseStreamingMode,
    messageFormatMode: settings.messageFormatMode ?? DEFAULT_TOPIC_DEFAULTS.messageFormatMode,
    showAssistantRunFooter: settings.showAssistantRunFooter ?? DEFAULT_TOPIC_DEFAULTS.showAssistantRunFooter,
    sendDiffFileAttachments: settings.sendDiffFileAttachments ?? DEFAULT_TOPIC_DEFAULTS.sendDiffFileAttachments,
    promptQueueEnabled: settings.promptQueueEnabled ?? DEFAULT_TOPIC_DEFAULTS.promptQueueEnabled,
    runState: settings.runState ?? "idle",
    updatedAt: settings.updatedAt ?? value.updatedAt ?? new Date().toISOString(),
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

export async function loadTopicRuntimeStates(): Promise<void> {
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
          if (typeof candidate.chatId !== "number" || typeof candidate.threadId !== "number") continue;
          const settings = migrateLegacyState(candidate);
          states.set(key(candidate.chatId, candidate.threadId), {
            chatId: candidate.chatId,
            threadId: candidate.threadId,
            settings,
            session: settings.session,
            model: settings.model,
            agent: settings.agent,
            compactOutputMode: settings.compactOutputMode,
            updatedAt: settings.updatedAt,
          });
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

function queuePersist(): void { writeQueue = writeQueue.catch(() => {}).then(() => persist()).catch(() => {}); }

export function createTopicSettings(defaults: Partial<TopicDefaults> = {}): TopicSettings {
  const now = new Date().toISOString();
  return {
    ...DEFAULT_TOPIC_DEFAULTS,
    ...defaults,
    runState: "idle",
    updatedAt: now,
  };
}

export async function initializeTopicRuntimeState(
  chatId: number,
  threadId: number,
  defaults?: Partial<TopicDefaults> & Partial<Pick<TopicSettings, "session" | "workspaceDirectory">>,
): Promise<TopicRuntimeState> {
  await loadTopicRuntimeStates();
  return ensureTopicRuntimeStateSync(chatId, threadId, defaults);
}

export function getTopicRuntimeStateSync(chatId: number, threadId: number): TopicRuntimeState | null {
  const state = states.get(key(chatId, threadId));
  return state ? clone(state) : null;
}

export async function getTopicRuntimeState(chatId: number, threadId: number): Promise<TopicRuntimeState | null> {
  await loadTopicRuntimeStates();
  return getTopicRuntimeStateSync(chatId, threadId);
}

export function ensureTopicRuntimeStateSync(
  chatId: number,
  threadId: number,
  defaults?: Partial<TopicDefaults> & Partial<Pick<TopicSettings, "session" | "workspaceDirectory">>,
): TopicRuntimeState {
  const existing = states.get(key(chatId, threadId));
  if (existing) return clone(existing);

  const settings = createTopicSettings(defaults);
  const created: TopicRuntimeState = {
    chatId,
    threadId,
    settings,
    session: settings.session,
    model: settings.model,
    agent: settings.agent,
    compactOutputMode: settings.compactOutputMode,
    updatedAt: settings.updatedAt,
  };
  states.set(key(chatId, threadId), created);
  queuePersist();
  return clone(created);
}

export function updateTopicRuntimeStateSync(
  chatId: number,
  threadId: number,
  patch: Partial<TopicSettings> & Partial<Pick<TopicRuntimeState, "session" | "model" | "agent" | "compactOutputMode">>,
): TopicRuntimeState {
  const previous = ensureTopicRuntimeStateSync(chatId, threadId);
  const settingsPatch: Partial<TopicSettings> = {
    ...patch,
    session: patch.session === undefined ? previous.settings.session : patch.session,
    model: patch.model === undefined ? previous.settings.model : patch.model,
    agent: patch.agent === undefined ? previous.settings.agent : patch.agent,
    compactOutputMode: patch.compactOutputMode === undefined ? previous.settings.compactOutputMode : patch.compactOutputMode,
  };
  const nextSettings: TopicSettings = {
    ...previous.settings,
    ...settingsPatch,
    session: settingsPatch.session ? { ...settingsPatch.session } : undefined,
    model: settingsPatch.model ? { ...settingsPatch.model } : undefined,
    updatedAt: new Date().toISOString(),
  };
  const next: TopicRuntimeState = {
    ...previous,
    settings: nextSettings,
    session: nextSettings.session,
    model: nextSettings.model,
    agent: nextSettings.agent,
    compactOutputMode: nextSettings.compactOutputMode,
    updatedAt: nextSettings.updatedAt,
  };
  states.set(key(chatId, threadId), next);
  queuePersist();
  return clone(next);
}

export async function updateTopicRuntimeState(
  chatId: number,
  threadId: number,
  patch: Partial<TopicSettings> & Partial<Pick<TopicRuntimeState, "session" | "model" | "agent" | "compactOutputMode">>,
): Promise<TopicRuntimeState> {
  await loadTopicRuntimeStates();
  return updateTopicRuntimeStateSync(chatId, threadId, patch);
}

export async function removeTopicRuntimeState(chatId: number, threadId: number): Promise<void> {
  await loadTopicRuntimeStates();
  states.delete(key(chatId, threadId));
  queuePersist();
}

export async function listTopicRuntimeStates(): Promise<TopicRuntimeState[]> {
  await loadTopicRuntimeStates();
  return [...states.values()].map(clone);
}

export type { MessageFormatMode, ResponseStreamingMode };
