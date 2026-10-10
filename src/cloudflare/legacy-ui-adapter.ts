import type { ControlStore, FleetTopic, SqlDatabase } from "./control-store.js";

export interface LegacyMainStatus {
  botVersion: string;
  coreVersion: string;
  model: string;
  agent: string;
}

export interface LegacyTopicSelection {
  model?: string;
  agent?: string;
  variant?: string;
  compact?: boolean;
  compactOutputMode?: boolean;
  promptQueueEnabled?: boolean;
  showThinkingContent?: boolean;
  responseStreamingMode?: string;
  messageFormatMode?: string;
  showAssistantRunFooter?: boolean;
  sendDiffFileAttachments?: boolean;
  imageModel?: string;
  voiceModel?: string;
  title?: string;
}

interface LegacyUiAdapterDependencies {
  sql: SqlDatabase;
  store: ControlStore;
  botVersion: string;
  coreVersion: string;
  rpc: <T = unknown>(topic: FleetTopic, operation: string, payload?: unknown) => Promise<T>;
  commitGlobal: (data: Record<string, unknown>, expectedRevision: number) => Promise<void>;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export class LegacyUiAdapter {
  constructor(private readonly deps: LegacyUiAdapterDependencies) {}

  async getMainStatus(): Promise<LegacyMainStatus> {
    const runtime = record(record(this.deps.store.global()?.data.configuration).runtime);
    return {
      botVersion: this.deps.botVersion,
      coreVersion: this.deps.coreVersion,
      model: typeof runtime.model === "string" ? runtime.model : "",
      agent: typeof runtime.agent === "string" ? runtime.agent : "build",
    };
  }

  catalogTopic(): FleetTopic | undefined {
    return this.deps.store.topics().find((topic) => {
      const worker = this.deps.store.worker(topic.workerId);
      return (
        topic.state === "ACTIVE" &&
        (!worker || ["BOUND_IDLE", "BOUND_ACTIVE", "SLEEPING"].includes(worker.state))
      );
    });
  }

  getTopicSelection(topic: FleetTopic): LegacyTopicSelection {
    this.assertWritableTopic(topic);
    const global = this.deps.store.global()?.data;
    const defaults = record(global?.defaults);
    const runtime = record(record(global?.configuration).runtime);
    const local = this.getUiState<LegacyTopicSelection>(this.topicKey(topic)) ?? {};
    const merged = {
      ...defaults,
      ...record(defaults.topicDefaults),
      ...local,
    } as LegacyTopicSelection & { topicDefaults?: unknown };
    delete merged.topicDefaults;
    if (!merged.model && typeof runtime.model === "string") merged.model = runtime.model;
    if (!merged.agent && typeof runtime.agent === "string") merged.agent = runtime.agent;
    return merged;
  }

  setTopicSelection(topic: FleetTopic, patch: Partial<LegacyTopicSelection>): void {
    this.assertWritableTopic(topic);
    const current = this.getUiState<LegacyTopicSelection>(this.topicKey(topic)) ?? {};
    const next = { ...current, ...patch };
    if (patch.compact !== undefined) next.compactOutputMode = patch.compact;
    if (patch.compactOutputMode !== undefined) next.compact = patch.compactOutputMode;
    this.setUiState(this.topicKey(topic), next);
  }

  getGlobalSnapshot(): { revision: number; data: Record<string, unknown> } | undefined {
    const snapshot = this.deps.store.global();
    return snapshot
      ? { revision: snapshot.revision, data: structuredClone(snapshot.data) }
      : undefined;
  }

  async commitGlobal(expectedRevision: number, data: Record<string, unknown>): Promise<void> {
    await this.deps.commitGlobal(structuredClone(data), expectedRevision);
  }

  async rpc<T = unknown>(topic: FleetTopic, operation: string, payload?: unknown): Promise<T> {
    this.assertWritableTopic(topic);
    const result = await this.deps.rpc<T>(topic, operation, payload);
    this.assertWritableTopic(topic);
    return result;
  }

  assertWritableTopic(topic: FleetTopic): void {
    const current = this.deps.store
      .topics()
      .find(
        (candidate) => candidate.chatId === topic.chatId && candidate.threadId === topic.threadId,
      );
    if (
      !current ||
      current.state !== "ACTIVE" ||
      current.workerId !== topic.workerId ||
      current.sessionId !== topic.sessionId ||
      current.generation !== topic.generation
    )
      throw new Error("stale_generation");
  }

  getUiState<T>(key: string): T | undefined {
    const row = [
      ...this.deps.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key=?", key),
    ][0];
    return row ? (JSON.parse(row.data) as T) : undefined;
  }

  setUiState(key: string, value: unknown): void {
    this.deps.sql.exec(
      "INSERT INTO ui_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
      key,
      JSON.stringify(value),
    );
  }

  deleteUiState(key: string): void {
    this.deps.sql.exec("DELETE FROM ui_state WHERE key=?", key);
  }

  private topicKey(topic: FleetTopic): string {
    return `topic:${topic.chatId}:${topic.threadId}:${topic.generation}`;
  }
}
