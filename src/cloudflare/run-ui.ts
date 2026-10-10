import {
  appendDuration,
  bucketElapsedMs,
  formatDuration,
  TOOL_ELAPSED_THRESHOLD_MS,
} from "../app/formatters/duration-formatter.js";
import { renderTelegramParts } from "../bot/render/pipeline.js";
import type { FleetTopic, SqlDatabase } from "./control-store.js";
import { CloudTelegram, TelegramDeliveryError } from "./telegram.js";
interface Preview {
  tools: Record<string, { name: string; status: string; started?: number; ended?: number }>;
  mode?: "draft" | "edit";
  draft?: number;
  finalized?: boolean;
  message?: number;
  delivery?: string;
  last?: string;
  signature?: string;
  at?: number;
  retryAt?: number;
}
// Display names are bot-owned: arbitrary extension/provider labels can contain secrets.
const toolIcons: Record<string, string> = {
  bash: "🖥",
  read: "📖",
  edit: "✏️",
  write: "📝",
  apply_patch: "✏️",
  glob: "🔎",
  grep: "🔎",
  webfetch: "🌐",
  websearch: "🌐",
  task: "🤖",
  todowrite: "📋",
  todoread: "📋",
  skill: "📚",
  question: "❓",
};
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
/** Compatibility-only preview for legacy/unsupported chats. Native runs never enter this path.
 * Never captures reasoning text, tool input/output or auth. */
export class CloudRunUi {
  constructor(
    private sql: SqlDatabase,
    private telegram: CloudTelegram,
    private now: () => number = Date.now,
  ) {}
  private get(run: string): Preview {
    const row = [
      ...this.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key=?", "run-ui:" + run),
    ][0];
    return row ? JSON.parse(row.data) : { tools: {} };
  }
  private save(run: string, value: Preview): void {
    this.sql.exec(
      "INSERT INTO ui_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
      "run-ui:" + run,
      JSON.stringify(value),
    );
  }
  capture(run: string, event: unknown): void {
    const e = obj(event),
      p = obj(e.properties),
      part = obj(p.part),
      id = String(part.id ?? p.partID ?? "");
    if (!id || id.length > 128) return;
    const state = this.get(run);
    if (
      e.type === "message.part.updated" &&
      part.type === "tool" &&
      typeof part.tool === "string"
    ) {
      if (Object.keys(state.tools).length < 32 || id in state.tools) {
        const status = obj(part.state).status;
        if (!["pending", "running", "completed", "error"].includes(String(status))) return;
        const previous = state.tools[id];
        // A replay must neither restart timers nor regress a terminal tool card.
        if (previous?.status === "completed" || previous?.status === "error") return;
        state.tools[id] = {
          name: Object.hasOwn(toolIcons, part.tool) ? part.tool : "tool",
          status: String(status),
          started: previous?.started ?? this.now(),
          ...(status === "completed" || status === "error" ? { ended: this.now() } : {}),
        };
      }
    } else return;
    this.save(run, state);
  }
  async progress(
    topic: FleetTopic,
    run: string,
    text: string,
    options: {
      compact?: boolean;
      compactOutputMode?: boolean;
      showThinkingContent?: boolean;
      responseStreamingMode?: string;
    },
  ): Promise<number | undefined> {
    if (options.responseStreamingMode === "off" || !this.writable(topic, run, false)) return;
    const state = this.get(run);
    if (state.finalized || ["SENDING", "RECONCILIATION_REQUIRED"].includes(state.delivery ?? ""))
      return;
    state.mode ??= options.responseStreamingMode === "draft" && topic.chatId > 0 ? "draft" : "edit";
    if (state.mode === "draft")
      state.draft ??=
        new DataView(crypto.getRandomValues(new Uint8Array(4)).buffer).getUint32(0) % 2147483647 ||
        1;
    if (
      state.mode !== "draft" &&
      state.delivery &&
      state.delivery !== "DELIVERED" &&
      state.delivery !== "PENDING"
    )
      return;
    if (state.retryAt !== undefined && this.now() < state.retryAt) return state.retryAt;
    if (state.at !== undefined && this.now() - state.at < 1500) return state.at + 1500;
    const tools =
      options.compact || options.compactOutputMode
        ? ""
        : Object.values(state.tools)
            .slice(-6)
            .map((t) => {
              const elapsed = Math.max(0, (t.ended ?? this.now()) - (t.started ?? this.now()));
              const line =
                (t.status === "completed" ? "✓ " : t.status === "error" ? "✖ " : "⏳ ") +
                (toolIcons[t.name] ?? "⚙") +
                " " +
                t.name +
                " · " +
                t.status;
              return elapsed >= TOOL_ELAPSED_THRESHOLD_MS
                ? appendDuration(
                    line,
                    formatDuration(t.ended === undefined ? bucketElapsedMs(elapsed) : elapsed),
                  )
                : line;
            })
            .join("\n");
    // Parse complete snapshots before selecting a bounded semantic chunk. Never
    // cut Markdown delimiters, code, surrogate pairs or emoji source sequences.
    const snapshot = renderTelegramParts(
      [tools, text].filter(Boolean).join("\n\n"),
      { maxChars: 3800 },
    ).at(-1);
    if (!snapshot) return;
    const preview = JSON.stringify([snapshot.fallbackText, snapshot.entities]);
    const refresh =
      state.mode === "draft" && state.at !== undefined && this.now() - state.at >= 20_000;
    if (!preview || (preview === state.signature && !refresh)) return;
    if (state.mode === "draft") await this.draft(topic, run, state, preview, snapshot);
    else await this.deliver(topic, run, state, preview, snapshot, true);
  }
  async finish(
    topic: FleetTopic,
    run: string,
    text: string,
    part?: ReturnType<typeof renderTelegramParts>[number],
  ): Promise<boolean> {
    const state = this.get(run);
    if (!this.writable(topic, run, true, !state.mode && !state.message))
      throw new Error("run_ui_fenced");
    if (state.finalized) return true;
    if (!state.message && ["SENDING", "RECONCILIATION_REQUIRED"].includes(state.delivery ?? ""))
      throw new TelegramDeliveryError("ambiguous");
    if (!state.message && state.mode !== "draft") return false;
    if (!state.message || state.last !== text || part)
      await this.deliver(topic, run, state, text, part);
    state.finalized = true;
    this.save(run, state);
    return true;
  }
  private writable(
    topic: FleetTopic,
    run: string,
    finishing: boolean,
    legacyFinal = false,
  ): boolean {
    const row = [
      ...this.sql.exec<{ state: string; generation: number | null; data: string }>(
        "SELECT r.state,p.generation,t.data FROM runs r LEFT JOIN run_pins p ON p.request=r.request JOIN topics t ON t.chat=r.chat AND t.thread=r.thread WHERE r.request=? AND r.chat=? AND r.thread=?",
        run,
        topic.chatId,
        topic.threadId,
      ),
    ][0];
    const current = obj(row ? JSON.parse(row.data) : undefined);
    return (
      !!row &&
      topic.state === "ACTIVE" &&
      current.state === "ACTIVE" &&
      current.generation === topic.generation &&
      (row.generation === topic.generation || (legacyFinal && row.generation === null)) &&
      current.workerId === topic.workerId &&
      current.sessionId === topic.sessionId &&
      (row.state === "ACTIVE" || (finishing && ["COMPLETED", "FAILED"].includes(row.state)))
    );
  }
  private async draft(
    topic: FleetTopic,
    run: string,
    state: Preview,
    text: string,
    part: ReturnType<typeof renderTelegramParts>[number],
  ): Promise<void> {
    state.delivery = "DRAFT_SENDING";
    state.retryAt = this.now() + 15_000;
    this.save(run, state);
    try {
      await this.telegram.previewPart(
        "sendMessageDraft",
        {
          chat_id: topic.chatId,
          message_thread_id: topic.threadId,
          draft_id: state.draft,
        },
        part,
      );
      state = this.get(run);
      if (state.delivery !== "DRAFT_SENDING") return;
      state.delivery = "DELIVERED";
      state.retryAt = undefined;
      state.last = part.fallbackText;
      state.signature = text;
      state.at = this.now();
      this.save(run, state);
    } catch (error) {
      state = this.get(run);
      if (state.delivery !== "DRAFT_SENDING") return;
      if (error instanceof TelegramDeliveryError && error.reason === "unsupported_draft") {
        state.mode = "edit";
        state.delivery = "PENDING";
        this.save(run, state);
        if (this.writable(topic, run, false))
          await this.deliver(topic, run, state, text, part, true);
        return;
      }
      // Ephemeral draft replacement is safe to retry, including after ambiguous transport.
      const retry = error instanceof TelegramDeliveryError ? error.retryAfter : undefined;
      state.retryAt =
        this.now() +
        Math.max(1500, Number.isFinite(retry) ? Math.min(86400, Math.max(0, retry!)) * 1000 : 1500);
      state.delivery = "PENDING";
      this.save(run, state);
      throw error;
    }
  }
  private async deliver(
    topic: FleetTopic,
    run: string,
    state: Preview,
    text: string,
    part?: ReturnType<typeof renderTelegramParts>[number],
    preview = false,
  ): Promise<void> {
    const editing = !!state.message;
    state.delivery = "SENDING";
    this.save(run, state);
    try {
      const rendered = part ?? renderTelegramParts(text, { maxChars: 3800 })[0];
      if (!rendered) return;
      const result =
        preview || !part
          ? await this.telegram.previewPart(
              editing ? "editMessageText" : "sendMessage",
              {
                chat_id: topic.chatId,
                ...(editing
                  ? { message_id: state.message }
                  : { message_thread_id: topic.threadId }),
              },
              rendered,
            )
          : {
              message_id: editing
                ? await this.telegram.editPart(topic.chatId, state.message!, rendered)
                : await this.telegram.sendPart(topic.chatId, topic.threadId, rendered),
            };
      if (!editing) state.message = result.message_id;
      state.delivery = "DELIVERED";
      state.retryAt = undefined;
      state.last = rendered.fallbackText;
      state.signature = preview ? text : undefined;
      state.at = this.now();
      this.save(run, state);
    } catch (error) {
      state.delivery =
        error instanceof TelegramDeliveryError && error.category === "rate_limited"
          ? "PENDING"
          : "RECONCILIATION_REQUIRED";
      this.save(run, state);
      throw error;
    }
  }
}
