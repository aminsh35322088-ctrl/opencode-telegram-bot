import type { FleetTopic, SqlDatabase } from "./control-store.js";
import { CloudTelegram, TelegramDeliveryError } from "./telegram.js";
import { renderTelegramParts } from "../bot/render/pipeline.js";
import { shouldRenderRtl } from "../bot/render/text-direction.js";
import { t } from "../i18n/index.js";
import { isLongThinking } from "../bot/messages/thinking-rendering.js";

export type RunPresentationState =
  | "THINKING"
  | "ACTIVITY"
  | "STREAMING"
  | "FINALIZING"
  | "CANCELLING"
  | "CANCELLED"
  | "COMPLETED"
  | "FAILED"
  | "UNSUPPORTED";
export interface RunDraftBinding {
  chatId: number;
  threadId: number;
  sessionId: string;
  generation: number;
  workerId: string;
  runId: string;
  draftId: number;
  state: RunPresentationState;
  summaries: string[];
  thinking: string[];
  completedThinking: string[];
  activities: Record<string, string>;
  at?: number;
  retryAt?: number;
  signature?: string;
  sendingUntil?: number;
}
export interface NativeStop {
  chat: { id: number; type?: string };
  message_thread_id?: number;
  draft_id: number;
}
const active = (s: RunPresentationState) =>
  ["THINKING", "ACTIVITY", "STREAMING", "FINALIZING"].includes(s);
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const completedSummaryBlock = (text: string) =>
  isLongThinking(text)
    ? { type: "expandable_blockquote" as const, text }
    : {
        type: "blockquote" as const,
        blocks: [{ type: "paragraph" as const, text }],
      };
const tools = new Set([
  "read",
  "write",
  "edit",
  "apply_patch",
  "glob",
  "grep",
  "bash",
  "webfetch",
  "websearch",
  "task",
  "skill",
  "question",
  "todowrite",
  "todoread",
]);
/** Telegram ownership only. Never implements process cancellation or retains reasoning text. */
export class TelegramRunPresentationController {
  constructor(
    private readonly sql: SqlDatabase,
    private readonly telegram: CloudTelegram,
    private readonly now: () => number = Date.now,
  ) {}
  binding(run: string): RunDraftBinding | undefined {
    const row = [
      ...this.sql.exec<{ data: string }>(
        "SELECT data FROM telegram_run_presentations WHERE run=?",
        run,
      ),
    ][0];
    return row ? JSON.parse(row.data) : undefined;
  }
  private prune(topic: FleetTopic): void {
    const old = [
      ...this.sql.exec<{ run: string }>(
        "SELECT run FROM telegram_run_presentations WHERE chat=? AND thread=? AND json_extract(data,'$.state') IN ('COMPLETED','CANCELLED','FAILED','UNSUPPORTED') ORDER BY rowid DESC LIMIT 20 OFFSET 100",
        topic.chatId,
        topic.threadId,
      ),
    ];
    for (const { run } of old) {
      this.sql.exec("DELETE FROM telegram_run_presentations WHERE run=?", run);
      this.sql.exec("DELETE FROM ui_state WHERE key=?", `native-stop:${run}`);
    }
  }
  private save(b: RunDraftBinding): void {
    this.sql.exec(
      "UPDATE telegram_run_presentations SET data=? WHERE run=?",
      JSON.stringify(b),
      b.runId,
    );
  }
  private log(event: string, b: RunDraftBinding, extra: Record<string, unknown> = {}): void {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        event,
        chatId: b.chatId,
        threadId: b.threadId,
        generation: b.generation,
        sessionId: b.sessionId,
        runId: b.runId,
        draftId: b.draftId,
        presentationState: b.state,
        ...extra,
      }),
    );
  }
  private live(b: RunDraftBinding): boolean {
    const row = [
      ...this.sql.exec<{ data: string; state: string; generation: number }>(
        "SELECT t.data,r.state,p.generation FROM topics t JOIN runs r ON r.chat=t.chat AND r.thread=t.thread JOIN run_pins p ON p.request=r.request WHERE r.request=? AND t.chat=? AND t.thread=?",
        b.runId,
        b.chatId,
        b.threadId,
      ),
    ][0];
    const topic = object(row ? JSON.parse(row.data) : undefined);
    return (
      !!row &&
      topic.state === "ACTIVE" &&
      topic.generation === b.generation &&
      row.generation === b.generation &&
      topic.sessionId === b.sessionId &&
      topic.workerId === b.workerId &&
      ["ACTIVE", "FINALIZING", "COMPLETED", "FAILED"].includes(row.state)
    );
  }
  owns(topic: FleetTopic, run: string): boolean {
    const b = this.binding(run);
    return (
      !!b &&
      b.chatId === topic.chatId &&
      b.threadId === topic.threadId &&
      b.sessionId === topic.sessionId &&
      b.workerId === topic.workerId &&
      b.generation === topic.generation &&
      topic.state === "ACTIVE" &&
      this.live(b)
    );
  }
  enabled(run: string): boolean {
    const b = this.binding(run);
    return !!b && b.state !== "UNSUPPORTED";
  }
  canDeliver(topic: FleetTopic, run: string): boolean {
    const b = this.binding(run);
    return !b ? true : this.owns(topic, run) && (b.state === "UNSUPPORTED" || active(b.state));
  }
  async start(topic: FleetTopic, run: string): Promise<void> {
    if (topic.threadId <= 1 || topic.chatId <= 0) return;
    const capKey = `native-capability:${topic.chatId}`;
    const capability = () =>
      [...this.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key=?", capKey)][0];
    let b = this.binding(run);
    if (!b) {
      const legacy = [
        ...this.sql.exec<{ data: string }>(
          "SELECT data FROM ui_state WHERE key=?",
          `run-ui:${run}`,
        ),
      ][0];
      // An upgrade never changes the ownership of an already visible legacy preview.
      const state: RunPresentationState =
        capability()?.data === '\"unsupported\"' || legacy ? "UNSUPPORTED" : "THINKING";
      const row = [
        ...this.sql.exec<{ data: string }>(
          "INSERT INTO ui_state(key,data) VALUES('native-draft-sequence','1') ON CONFLICT(key) DO UPDATE SET data=CAST(CAST(data AS INTEGER)+1 AS TEXT) RETURNING data",
        ),
      ][0]!;
      const draftId = Number(row.data);
      if (!Number.isSafeInteger(draftId) || draftId > 2147483647)
        throw new Error("native_draft_identity_exhausted");
      b = {
        chatId: topic.chatId,
        threadId: topic.threadId,
        sessionId: topic.sessionId,
        generation: topic.generation,
        workerId: topic.workerId,
        runId: run,
        draftId,
        state,
        summaries: [],
        thinking: [],
        completedThinking: [],
        activities: {},
      };
      if (!this.live(b)) return;
      this.sql.exec(
        "INSERT INTO telegram_run_presentations VALUES(?,?,?,?,?) ON CONFLICT(run) DO NOTHING",
        run,
        topic.chatId,
        topic.threadId,
        draftId,
        JSON.stringify(b),
      );
      b = this.binding(run)!;
      this.prune(topic);
    }
    if (!active(b.state) || !this.owns(topic, run)) return;
    if (!capability()) {
      if ((b.retryAt ?? 0) > this.now()) return;
      try {
        const chat = await this.telegram.call<{ type: string }>("getChat", {
          chat_id: topic.chatId,
        });
        if (!this.owns(topic, run) || !active(this.binding(run)!.state)) return;
        if (chat.type !== "private") {
          this.unsupported(b, "chat_type");
          return;
        }
        this.sql.exec(
          "INSERT INTO ui_state VALUES(?,?) ON CONFLICT(key) DO NOTHING",
          capKey,
          JSON.stringify("private"),
        );
      } catch (error) {
        b = this.binding(run)!;
        if (!active(b.state)) return;
        b.retryAt = this.now() + 2000;
        this.save(b);
        this.log("native_draft_update_failed", b, {
          operation: "getChat",
          telegramApiResult:
            error instanceof TelegramDeliveryError ? error.category : "unavailable",
        });
        return;
      }
    }
    // start is admission only. Later alarm ticks publish the current answer snapshot,
    // never an empty heartbeat that could erase streamed text.
    if (b.at === undefined) await this.update(topic, run, "");
  }
  capture(topic: FleetTopic, run: string, event: unknown): void {
    const b = this.binding(run);
    if (!b || !active(b.state) || !this.owns(topic, run) || b.state === "FINALIZING") return;
    const e = object(event),
      p = object(e.properties),
      part = object(p.part);
    const id = typeof part.id === "string" ? part.id : "";
    if (e.type !== "message.part.updated" || !id || id.length > 128) return;
    const before = JSON.stringify(b);
    if (part.type === "reasoning") {
      if (typeof object(part.time).end === "number") {
        if (!b.completedThinking.includes(id) && b.thinking.includes(id)) {
          b.summaries = [...b.summaries, t("generation.summary", undefined, "en")].slice(-4);
          b.completedThinking = [...b.completedThinking, id].slice(-32);
          b.thinking = b.thinking.filter((v) => v !== id);
          this.log("native_thinking_completed", b);
        }
      } else if (!b.thinking.includes(id) && !b.completedThinking.includes(id))
        b.thinking = [...b.thinking, id].slice(-16);
    } else if (part.type === "tool") {
      const status = object(part.state).status;
      if (["running", "pending"].includes(String(status))) {
        if (Object.keys(b.activities).length < 16 || id in b.activities)
          b.activities[id] = tools.has(String(part.tool)) ? String(part.tool) : "tool";
      } else if (["completed", "error"].includes(String(status))) delete b.activities[id];
    } else return;
    b.state = Object.keys(b.activities).length ? "ACTIVITY" : "THINKING";
    if (JSON.stringify(b) !== before) {
      this.save(b);
      this.log("native_activity_changed", b);
    }
  }
  finalizing(topic: FleetTopic, run: string): void {
    const b = this.binding(run);
    if (!b || !active(b.state) || !this.owns(topic, run)) return;
    if (b.state !== "FINALIZING") {
      b.state = "FINALIZING";
      b.activities = {};
      b.thinking = [];
      this.save(b);
      this.log("native_draft_finalizing", b);
    }
  }
  private unsupported(b: RunDraftBinding, reason: string, apiCode?: number, chatWide = true): void {
    const current = this.binding(b.runId);
    if (!current || !active(current.state)) return;
    current.state = "UNSUPPORTED";
    current.sendingUntil = undefined;
    this.save(current);
    if (chatWide)
      this.sql.exec(
        "INSERT INTO ui_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
        `native-capability:${b.chatId}`,
        JSON.stringify("unsupported"),
      );
    this.sql.exec("DELETE FROM ui_state WHERE key=?", `native-qualified:${b.chatId}`);
    this.log("native_capability_rejected", current, {
      operation: "sendRichMessageDraft",
      telegramApiResult: reason,
      apiCode,
    });
  }
  async restore(topic: FleetTopic, run: string, text: string): Promise<void> {
    const b = this.binding(run);
    if (!b || !active(b.state) || !this.owns(topic, run)) return;
    b.at = undefined;
    b.signature = undefined;
    this.save(b);
    await this.update(topic, run, text);
  }
  async update(topic: FleetTopic, run: string, text: string): Promise<number | undefined> {
    let b = this.binding(run);
    if (!b || !active(b.state) || !this.owns(topic, run)) return;
    const cap = [
      ...this.sql.exec<{ data: string }>(
        "SELECT data FROM ui_state WHERE key=?",
        `native-capability:${topic.chatId}`,
      ),
    ][0];
    if (cap?.data !== JSON.stringify("private")) return b.retryAt ?? this.now() + 2000;
    const now = this.now();
    if ((b.sendingUntil ?? 0) > now) return b.sendingUntil;
    if ((b.retryAt ?? 0) > now) return b.retryAt;
    if (b.at !== undefined && now - b.at < 1500) return b.at + 1500;
    if (b.state !== "FINALIZING" && b.state !== "ACTIVITY" && !b.thinking.length && text)
      b.state = "STREAMING";
    const activity = Object.values(b.activities).at(-1);
    const label =
      b.state === "FINALIZING"
        ? t("generation.finalizing", undefined, "en")
        : activity
          ? t("generation.activity", { activity }, "en")
          : b.thinking.length
            ? t("bot.thinking", undefined, "en")
            : text
              ? t("generation.streaming", undefined, "en")
              : t("bot.thinking", undefined, "en");
    const content = text
      ? (renderTelegramParts(text, { maxChars: 3000 }).at(-1)?.blocks ?? [])
      : [];
    const blocks = [
      ...b.summaries.map(completedSummaryBlock),
      ...content,
      { type: "thinking", text: label },
    ];
    const signature = JSON.stringify(blocks);
    if (b.signature === signature && b.at !== undefined && now - b.at < 10_000)
      return b.at + 10_000;
    b.sendingUntil = now + 16_000;
    this.save(b);
    try {
      await this.telegram.call("sendRichMessageDraft", {
        chat_id: b.chatId,
        message_thread_id: b.threadId,
        draft_id: b.draftId,
        rich_message: { blocks, is_rtl: shouldRenderRtl(text) },
        can_stop: true,
        keep_on_stop: false,
      });
      b = this.binding(run)!;
      if (!active(b.state) || !this.owns(topic, run)) return;
      b.at = this.now();
      b.retryAt = undefined;
      b.sendingUntil = undefined;
      b.signature = signature;
      this.save(b);
      this.log("native_draft_updated", b, {
        operation: "sendRichMessageDraft",
        telegramApiResult: "accepted",
      });
      return b.at + 10_000;
    } catch (error) {
      b = this.binding(run)!;
      if (!active(b.state) || !this.owns(topic, run)) return;
      b.sendingUntil = undefined;
      if (error instanceof TelegramDeliveryError && error.category === "rejected") {
        this.unsupported(
          b,
          error.reason ?? "request_rejected",
          error.apiCode,
          error.reason === "unsupported_draft",
        );
        return;
      }
      b.retryAt =
        this.now() +
        Math.max(
          1500,
          (error instanceof TelegramDeliveryError ? (error.retryAfter ?? 2) : 2) * 1000,
        );
      this.save(b);
      this.log("native_draft_update_failed", b, {
        operation: "sendRichMessageDraft",
        telegramApiResult: error instanceof TelegramDeliveryError ? error.category : "unavailable",
      });
      return b.retryAt;
    }
  }
  acceptStop(stop: NativeStop): RunDraftBinding | undefined {
    if (
      !Number.isSafeInteger(stop.chat?.id) ||
      stop.chat.id <= 0 ||
      stop.chat.type !== "private" ||
      !Number.isSafeInteger(stop.message_thread_id) ||
      stop.message_thread_id! <= 1 ||
      !Number.isSafeInteger(stop.draft_id) ||
      !stop.draft_id
    )
      return;
    const row = [
      ...this.sql.exec<{ data: string }>(
        "SELECT data FROM telegram_run_presentations WHERE chat=? AND thread=? AND draft=?",
        stop.chat.id,
        stop.message_thread_id,
        stop.draft_id,
      ),
    ][0];
    if (!row) return;
    const b = JSON.parse(row.data) as RunDraftBinding;
    this.log("native_stop_received", b);
    if (!active(b.state) || !this.live(b)) {
      this.log("native_stop_rejected_stale", b);
      return;
    }
    // Synchronous durable output fence commits before any cancellation I/O.
    b.state = "CANCELLING";
    this.save(b);
    this.sql.exec(
      "UPDATE runs SET state='CANCELLING' WHERE request=? AND chat=? AND thread=? AND state IN ('ACTIVE','FINALIZING','COMPLETED','FAILED')",
      b.runId,
      b.chatId,
      b.threadId,
    );
    this.sql.exec("UPDATE responses SET state='FENCED' WHERE run=?", b.runId);
    this.sql.exec("DELETE FROM active_runs WHERE request=?", b.runId);
    this.log("native_stop_accepted", b);
    return b;
  }
  pendingCancellations(): RunDraftBinding[] {
    return [
      ...this.sql.exec<{ data: string }>(
        "SELECT data FROM telegram_run_presentations WHERE json_extract(data,'$.state')='CANCELLING' LIMIT 20",
      ),
    ].map((r) => JSON.parse(r.data));
  }
  cancelled(run: string): void {
    const b = this.binding(run);
    if (!b || b.state !== "CANCELLING") return;
    b.state = "CANCELLED";
    b.activities = {};
    b.thinking = [];
    this.save(b);
    this.sql.exec("UPDATE runs SET state='CANCELLED' WHERE request=? AND state='CANCELLING'", run);
    this.sql.exec("DELETE FROM active_runs WHERE request=?", run);
    this.sql.exec("DELETE FROM pending_responses WHERE run=?", run);
    this.log("run_cancelled", b);
  }
  fenceTopic(topic: FleetTopic): void {
    for (const row of this.sql.exec<{ data: string }>(
      "SELECT data FROM telegram_run_presentations WHERE chat=? AND thread=? AND json_extract(data,'$.state') IN ('THINKING','ACTIVITY','STREAMING','FINALIZING') LIMIT 20",
      topic.chatId,
      topic.threadId,
    )) {
      const b = JSON.parse(row.data) as RunDraftBinding;
      if (active(b.state)) {
        b.state = "CANCELLING";
        this.save(b);
      }
    }
  }
  activeBinding(topic: FleetTopic): RunDraftBinding | undefined {
    const row = [
      ...this.sql.exec<{ data: string }>(
        "SELECT data FROM telegram_run_presentations WHERE chat=? AND thread=? AND json_extract(data,'$.state') IN ('THINKING','ACTIVITY','STREAMING','FINALIZING') LIMIT 1",
        topic.chatId,
        topic.threadId,
      ),
    ][0];
    const b = row ? (JSON.parse(row.data) as RunDraftBinding) : undefined;
    return b && this.owns(topic, b.runId) ? b : undefined;
  }
  finalizingBindings(): RunDraftBinding[] {
    return [
      ...this.sql.exec<{ data: string }>(
        "SELECT data FROM telegram_run_presentations WHERE json_extract(data,'$.state')='FINALIZING' LIMIT 20",
      ),
    ].map((row) => JSON.parse(row.data));
  }
  async complete(topic: FleetTopic, run: string, outcome: "COMPLETED" | "FAILED"): Promise<void> {
    const b = this.binding(run);
    if (!b || !active(b.state) || !this.owns(topic, run)) return;
    b.state = outcome;
    b.activities = {};
    b.thinking = [];
    this.save(b);
    this.log("native_draft_completed", b);
    // Telegram's persistent send clears its ephemeral draft/Stop envelope.
    // Do not publish an empty draft afterwards: that would start another Thinking placeholder.
  }
}
