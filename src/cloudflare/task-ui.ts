import type { ControlStore, FleetTopic, SqlDatabase } from "./control-store.js";

export interface TaskButton {
  text: string;
  callback_data: string;
}
/** Parent authenticates actor and generation before calling this scoped UI. */
export interface TaskContext {
  sql: SqlDatabase;
  store: ControlStore;
  actorId: number;
  chatId: number;
  threadId: number;
  generation: number;
  now?: () => number;
  /** Persist the parent update/callback mutation receipt synchronously, before Telegram I/O. */
  markCommitted?(): void;
  button(label: string, action: string, value?: string): TaskButton;
  prompt(kind: string, text: string): Promise<void>;
  notice(text: string): Promise<void>;
  menu(text: string, rows: TaskButton[][]): Promise<void>;
}
export interface CloudScheduledTask {
  id: string;
  actorId: number;
  chatId: number;
  threadId: number;
  workerId: string;
  generation: number;
  prompt: string;
  every?: number;
  due: number;
  enabled: boolean;
  version: number;
  retryAt?: number;
  lastRequest?: string;
  lastOccurrence?: number;
}
const RETRY_MS = 60_000;
const validId = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(value) ||
    ["__proto__", "constructor", "prototype"].includes(value)
  )
    throw new Error("invalid_task_id");
  return value;
};
const utc = (value: unknown): number => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  )
    throw new Error("invalid_task_utc_time");
  const time = Date.parse(value);
  if (
    !Number.isSafeInteger(time) ||
    new Date(time).toISOString().replace(".000Z", "Z") !== value.replace(".000Z", "Z")
  )
    throw new Error("invalid_task_utc_time");
  return time;
};
const esc = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Durable schedules only admit ordinary topic prompts; worker execution is owned by the parent queue. */
export class CloudTaskUi {
  constructor(private readonly context: TaskContext) {}
  private now(): number {
    return this.context.now?.() ?? Date.now();
  }
  private tasks(): CloudScheduledTask[] {
    return [
      ...this.context.sql.exec<{ data: string }>(
        "SELECT data FROM ui_state WHERE key LIKE 'task:%'",
      ),
    ].map((row) => JSON.parse(row.data) as CloudScheduledTask);
  }
  private write(task: CloudScheduledTask): void {
    this.context.sql.exec(
      "INSERT INTO ui_state(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
      `task:${task.id}`,
      JSON.stringify(task),
    );
  }
  private topic(task?: CloudScheduledTask): FleetTopic | undefined {
    const owner = task ?? this.context;
    if (!Number.isSafeInteger(owner.threadId) || owner.threadId <= 1) return;
    const topic = this.context.store
      .topics()
      .find(
        (t) =>
          t.chatId === owner.chatId &&
          t.threadId === owner.threadId &&
          t.generation === owner.generation &&
          t.state === "ACTIVE",
      );
    if (!topic || (task && topic.workerId !== task.workerId)) return;
    const worker = this.context.store.worker(topic.workerId);
    if (
      !worker ||
      worker.generation !== topic.generation ||
      worker.chatId !== topic.chatId ||
      worker.threadId !== topic.threadId ||
      ["FENCING", "CLEANING", "REPLACED", "DELETING"].includes(worker.state)
    )
      return;
    return topic;
  }
  private scoped(): CloudScheduledTask[] {
    const c = this.context;
    return this.tasks().filter(
      (t) =>
        t.actorId === c.actorId &&
        t.chatId === c.chatId &&
        t.threadId === c.threadId &&
        t.generation === c.generation &&
        this.topic(t),
    );
  }
  async handle(action: string, value?: string): Promise<boolean> {
    if (
      ![
        "task",
        "tasklist",
        "config_task_save",
        "config_task_toggle",
        "config_task_delete",
      ].includes(action)
    )
      return false;
    if (action === "tasklist") {
      await this.list();
      return true;
    }
    const topic = this.topic();
    if (!topic) throw new Error("topic_required");
    if (!Number.isSafeInteger(this.context.actorId) || this.context.actorId <= 0)
      throw new Error("invalid_task_actor");
    if (action === "task") {
      await this.context.prompt(
        "config_task_save",
        'Send task JSON: {"prompt":"Check project","at":"2026-10-09T10:00:00Z"} or {"prompt":"Check project","every":3600000}. Times use UTC; intervals use milliseconds (minimum 60000).',
      );
      return true;
    }
    if (action === "config_task_save") {
      if (!value || value.length > 22000) throw new Error("invalid_task_input");
      const input: unknown = JSON.parse(value);
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("invalid_task_input");
      const data = input as Record<string, unknown>;
      if (Object.keys(data).some((k) => !["id", "prompt", "at", "every", "due"].includes(k)))
        throw new Error("invalid_task_fields");
      if (
        typeof data.prompt !== "string" ||
        !data.prompt.trim() ||
        data.prompt.length > 20000 ||
        data.prompt.includes("\0")
      )
        throw new Error("invalid_task_prompt");
      const id = validId(data.id ?? crypto.randomUUID());
      const existing = this.tasks().find((t) => t.id === id);
      if (existing && !this.scoped().some((t) => t.id === id))
        throw new Error("task_owner_mismatch");
      if (!existing && this.tasks().length >= 100) throw new Error("task_limit");
      const every = data.every;
      if (
        every !== undefined &&
        (!Number.isSafeInteger(every) || Number(every) < RETRY_MS || Number(every) > 366 * 86400000)
      )
        throw new Error("invalid_task_interval");
      if (
        (data.at !== undefined) === (every !== undefined) ||
        (data.at !== undefined && data.due !== undefined)
      )
        throw new Error("invalid_task_schedule");
      const due =
        data.at !== undefined
          ? utc(data.at)
          : data.due !== undefined
            ? utc(data.due)
            : this.now() + Number(every);
      if (existing?.lastOccurrence !== undefined && due <= existing.lastOccurrence)
        throw new Error("task_occurrence_already_admitted");
      this.write({
        id,
        actorId: this.context.actorId,
        chatId: topic.chatId,
        threadId: topic.threadId,
        workerId: topic.workerId,
        generation: topic.generation,
        prompt: data.prompt.trim(),
        ...(every !== undefined ? { every: Number(every) } : {}),
        due,
        enabled: true,
        version: (existing?.version ?? 0) + 1,
        ...(existing?.lastRequest
          ? { lastRequest: existing.lastRequest, lastOccurrence: existing.lastOccurrence }
          : {}),
      });
      this.context.markCommitted?.();
      await this.context.notice("Scheduled task saved.");
    } else {
      const id = validId(value);
      const task = this.scoped().find((t) => t.id === id);
      if (!task) throw new Error("task_not_found");
      if (action === "config_task_delete")
        this.context.sql.exec("DELETE FROM ui_state WHERE key=?", `task:${id}`);
      else
        this.write({
          ...task,
          enabled: !task.enabled,
          version: task.version + 1,
          retryAt: undefined,
        });
      this.context.markCommitted?.();
      await this.context.notice(
        action === "config_task_delete"
          ? "Scheduled task deleted."
          : task.enabled
            ? "Scheduled task paused."
            : "Scheduled task resumed.",
      );
    }
    return true;
  }
  private async list(): Promise<void> {
    const tasks = this.scoped().sort((a, b) => a.due - b.due || a.id.localeCompare(b.id));
    const rows = tasks.flatMap((task) => [
      [
        this.context.button(
          `${task.enabled ? "Pause" : "Resume"}: ${task.id}`,
          "config_task_toggle",
          task.id,
        ),
        this.context.button("Delete", "config_task_delete", task.id),
      ],
    ]);
    if (this.topic()) rows.push([this.context.button("Create scheduled task", "task")]);
    await this.context.menu(
      tasks.length
        ? tasks
            .map(
              (t) =>
                `${esc(t.id)} · ${t.enabled ? new Date(t.due).toISOString() : "paused"} · ${esc(t.prompt.slice(0, 100))}`,
            )
            .join("\n")
        : "No scheduled tasks in this topic.",
      rows,
    );
  }
  nextDue(): number | undefined {
    const values = this.tasks()
      .filter((t) => t.enabled && this.topic(t))
      .map((t) => Math.max(t.due, t.retryAt ?? 0));
    return values.length ? Math.min(...values) : undefined;
  }
  async tick(
    enqueue: (topic: FleetTopic, requestId: string, text: string) => Promise<void>,
  ): Promise<number | undefined> {
    const lease = crypto.randomUUID(),
      now = this.now();
    if (!this.context.store.acquireLease("scheduled-task-tick", lease, now, RETRY_MS))
      return Math.max(now + RETRY_MS, this.nextDue() ?? 0);
    try {
      const tasks = this.tasks();
      for (const task of tasks)
        if (task.enabled && !this.topic(task))
          this.write({ ...task, enabled: false, version: task.version + 1 });
      const due = tasks
        .filter((t) => t.enabled && this.topic(t) && Math.max(t.due, t.retryAt ?? 0) <= now)
        .sort((a, b) => a.due - b.due || a.id.localeCompare(b.id))
        .slice(0, 10);
      for (const task of due) {
        const topic = this.topic(task);
        if (!topic) continue;
        const previous = task.lastRequest
          ? [
              ...this.context.sql.exec<{ state: string }>(
                "SELECT state FROM runs WHERE request=?",
                task.lastRequest,
              ),
            ][0]
          : undefined;
        if (previous && ["QUEUED", "ACTIVE"].includes(previous.state)) {
          this.write({ ...task, retryAt: now + RETRY_MS });
          continue;
        }
        const requestId = `task_${task.id}_${task.due}`;
        try {
          await enqueue(topic, requestId, task.prompt);
          const current = this.tasks().find((t) => t.id === task.id);
          if (!current) continue;
          if (current.version !== task.version) {
            // A concurrent edit changes future occurrences, while this admitted run still fences overlap.
            const sameOccurrence = current.due <= task.due;
            this.write({
              ...current,
              ...(sameOccurrence
                ? {
                    due: current.every ? task.due + current.every : current.due,
                    enabled: current.enabled && Boolean(current.every),
                  }
                : {}),
              lastRequest: requestId,
              lastOccurrence: task.due,
            });
            continue;
          }
          const next = task.every
            ? task.due + (Math.floor(Math.max(0, now - task.due) / task.every) + 1) * task.every
            : task.due;
          this.write({
            ...current,
            due: next,
            enabled: Boolean(task.every),
            retryAt: undefined,
            lastRequest: requestId,
            lastOccurrence: task.due,
          });
        } catch {
          const current = this.tasks().find((t) => t.id === task.id);
          if (current?.version === task.version)
            this.write({ ...current, retryAt: now + RETRY_MS });
        }
      }
      return this.nextDue();
    } finally {
      this.context.store.releaseLease("scheduled-task-tick", lease);
    }
  }
}
