import type { ControlStore, FleetTopic, SqlDatabase } from "./control-store.js";
import { CloudTelegram, TelegramDeliveryError } from "./telegram.js";

interface TitleState {
  topic: FleetTopic;
  title: string;
  revision: number;
  status: "pending" | "applied" | "failed" | "cancelled";
  attempts: number;
  retryAt: number;
  applied?: string;
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const scope = (topic: FleetTopic): string =>
  `${topic.chatId}:${topic.threadId}:${topic.generation}`;

const cleanPromptTitle = (prompt: string): string | undefined => {
  let text = prompt
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/https?:\/\/\S+/gu, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!text || text.startsWith("/") || text === "Please inspect the attached file.") return undefined;
  text = text.replace(/^(?:لطفاً|لطفا)\s+/u, "").trim();

  const about = /^(?:می(?:‌| )?خوام\s+)?(?:درباره(?:\s*ی|‌ی)?|در مورد|راجع به)\s+(.+)$/u.exec(text);
  if (about) {
    const subject = about[1]!
      .replace(/[؟?!.,،]+$/u, "")
      .replace(/\s+(?:تحقیق|بررسی|توضیح|صحبت)(?:\s+(?:کن|کنیم|کنید|بکن|بکنیم))?$/u, "")
      .trim();
    if (subject) text = "بررسی " + subject;
  }

  const firstSentence = text.split(/[\n.!?؟]/u, 1)[0]!.trim();
  const words = firstSentence.split(/\s+/u).filter(Boolean);
  const concise = words.length > 10 ? words.slice(0, 10).join(" ") : firstSentence;
  const title = [...concise].slice(0, 128).join("").trim();
  return title || undefined;
};

/** Telegram presentation of Core-owned titles from already authenticated, admitted events. */
export class CloudTopicTitleUi {
  constructor(
    private readonly sql: SqlDatabase,
    private readonly store: ControlStore,
    private readonly telegram: CloudTelegram,
    private readonly now: () => number = Date.now,
  ) {}

  private get<T>(key: string): T | undefined {
    const row = [
      ...this.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key=?", key),
    ][0];
    return row ? (JSON.parse(row.data) as T) : undefined;
  }

  private save(key: string, value: unknown): void {
    this.sql.exec(
      "INSERT INTO ui_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
      key,
      JSON.stringify(value),
    );
  }

  private options(topic: FleetTopic): Record<string, unknown> {
    return this.get<Record<string, unknown>>("topic:" + scope(topic)) ?? {};
  }

  private manual(topic: FleetTopic): boolean {
    const options = this.options(topic);
    return (
      options.titleSource === "manual" ||
      (typeof options.title === "string" &&
        !!options.title.trim() &&
        options.titleSource !== "auto")
    );
  }

  private live(topic: FleetTopic): boolean {
    if (topic.threadId <= 1 || topic.state !== "ACTIVE") return false;
    const current = this.store
      .topics()
      .find((item) => item.chatId === topic.chatId && item.threadId === topic.threadId);
    const worker = this.store.worker(topic.workerId);
    return !!(
      current?.state === "ACTIVE" &&
      current.workerId === topic.workerId &&
      current.sessionId === topic.sessionId &&
      current.generation === topic.generation &&
      worker?.generation === topic.generation &&
      ["BOUND_IDLE", "BOUND_ACTIVE", "SLEEPING"].includes(worker.state)
    );
  }

  private queue(topic: FleetTopic, title: string): boolean {
    const key = "title-ui:" + scope(topic),
      previous = this.get<TitleState>(key);
    if (previous?.title === title) return false;
    this.save(key, {
      topic,
      title,
      revision: (previous?.revision ?? 0) + 1,
      status: "pending",
      attempts: 0,
      retryAt: this.now(),
      ...(previous?.applied ? { applied: previous.applied } : {}),
    } satisfies TitleState);
    return true;
  }

  capturePrompt(topic: FleetTopic, prompt: string): boolean {
    if (!this.live(topic) || this.manual(topic)) return false;
    const current = this.options(topic).title;
    if (typeof current === "string" && current.trim() && !/^#[1-9]\d*$/.test(current.trim()))
      return false;
    const title = cleanPromptTitle(prompt);
    return title ? this.queue(topic, title) : false;
  }

  capture(topic: FleetTopic, event: unknown): boolean {
    const e = object(event),
      info = object(object(e.properties).info);
    if (
      e.type !== "session.updated" ||
      info.id !== topic.sessionId ||
      info.parentID !== undefined ||
      typeof info.title !== "string" ||
      info.title.length > 4096 ||
      !this.live(topic) ||
      this.manual(topic)
    )
      return false;
    const cleaned = info.title
      .replace(/\s+/gu, " ")
      .replace(/[\p{Cc}\p{Cf}]/gu, "")
      .trim();
    if (!cleaned || /^(?:New|Child) session(?:$|\s+-\s+\d{4}-\d{2}-\d{2}T)/u.test(cleaned))
      return false;
    const title = [...cleaned].slice(0, 128).join("").trim();
    return this.queue(topic, title);
  }

  /** Lets the control plane schedule persisted retries even after the run has completed. */
  nextDue(): number | undefined {
    const row = [
      ...this.sql.exec<{ due: number | null }>(
        "SELECT MIN(json_extract(data,'$.retryAt')) AS due FROM ui_state WHERE key GLOB 'title-ui:*' AND json_extract(data,'$.status')='pending'",
      ),
    ][0];
    return typeof row?.due === "number" ? Math.max(this.now(), row.due) : undefined;
  }

  /** Called by the durable alarm. No timer or model call is created here. */
  async flush(): Promise<void> {
    const rows = [
      ...this.sql.exec<{ key: string; data: string }>(
        "SELECT key,data FROM ui_state WHERE key GLOB 'title-ui:*' AND json_extract(data,'$.status')='pending' AND json_extract(data,'$.retryAt')<=? ORDER BY rowid LIMIT 20",
        this.now(),
      ),
    ];
    for (const row of rows) {
      // A previous awaited edit can interleave with a newly admitted event or manual rename.
      const state = this.get<TitleState>(row.key);
      if (!state || state.status !== "pending" || state.retryAt > this.now()) continue;
      if (!this.live(state.topic) || this.manual(state.topic)) {
        this.save(row.key, { ...state, status: "cancelled" });
        continue;
      }
      if (state.attempts >= 5) {
        this.save(row.key, { ...state, status: "failed" });
        continue;
      }
      const attempt = state.attempts + 1;
      const backoff = Math.min(60_000, 1000 * 2 ** (attempt - 1));
      // Persist before I/O so a restart cannot bypass the attempt budget or hot-loop.
      this.save(row.key, { ...state, attempts: attempt, retryAt: this.now() + 16_000 + backoff });
      let failure: unknown;
      let succeeded = false;
      try {
        await this.telegram.call("editForumTopic", {
          chat_id: state.topic.chatId,
          message_thread_id: state.topic.threadId,
          name: state.title,
        });
        succeeded = true;
      } catch (error) {
        failure = error;
      }
      const current = this.get<TitleState>(row.key);
      if (!current) continue;
      if (!this.live(state.topic) || this.manual(state.topic)) {
        this.save(row.key, { ...current, status: "cancelled" });
        continue;
      }
      if (succeeded) {
        this.save("topic:" + scope(state.topic), {
          ...this.options(state.topic),
          title: state.title,
          titleSource: "auto",
        });
        this.save(row.key, {
          ...current,
          applied: state.title,
          ...(current.revision === state.revision ? { status: "applied" } : {}),
        });
      } else if (current.revision === state.revision) {
        const retry =
          !(failure instanceof TelegramDeliveryError) || failure.category !== "rejected";
        const retrySeconds =
          failure instanceof TelegramDeliveryError ? failure.retryAfter : undefined;
        const retryDelay =
          typeof retrySeconds === "number" && Number.isFinite(retrySeconds) && retrySeconds > 0
            ? Math.min(Number.MAX_SAFE_INTEGER - this.now(), retrySeconds * 1000)
            : backoff;
        this.save(row.key, {
          ...current,
          status: retry && attempt < 5 ? "pending" : "failed",
          retryAt: this.now() + Math.max(backoff, retryDelay),
        });
      }
    }
  }
}
