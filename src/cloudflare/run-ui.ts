import type { FleetTopic, SqlDatabase } from "./control-store.js";
import { CloudTelegram, TelegramDeliveryError } from "./telegram.js";
interface Preview {
  thoughts: Record<string, string>;
  tools: Record<string, { name: string; status: string }>;
  message?: number;
  delivery?: string;
  last?: string;
  at?: number;
}
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
/** Bounded presentation of accepted signed events. Never includes tool input/output or auth. */
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
    return row ? JSON.parse(row.data) : { thoughts: {}, tools: {} };
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
      part.type === "reasoning" &&
      typeof part.text === "string"
    ) {
      if (Object.keys(state.thoughts).length < 16 || id in state.thoughts)
        state.thoughts[id] = part.text.slice(-8000);
    } else if (
      e.type === "message.part.delta" &&
      p.field === "text" &&
      typeof p.delta === "string" &&
      id in state.thoughts
    )
      state.thoughts[id] = (state.thoughts[id] + p.delta).slice(-8000);
    else if (
      e.type === "message.part.updated" &&
      part.type === "tool" &&
      typeof part.tool === "string"
    ) {
      if (Object.keys(state.tools).length < 32 || id in state.tools)
        state.tools[id] = {
          name: part.tool.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 80),
          status: String(obj(part.state).status ?? "pending")
            .replace(/[^A-Za-z_]/g, "")
            .slice(0, 30),
        };
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
  ): Promise<void> {
    if (options.responseStreamingMode === "off") return;
    const state = this.get(run);
    if (state.delivery && state.delivery !== "DELIVERED" && state.delivery !== "PENDING") return;
    const tools =
      options.compact || options.compactOutputMode
        ? ""
        : Object.values(state.tools)
            .slice(-6)
            .map(
              (t) =>
                (t.status === "completed" ? "✓ " : t.status === "error" ? "✖ " : "⚙ ") +
                t.name +
                " · " +
                t.status,
            )
            .join("\n");
    const thought =
      options.showThinkingContent && !options.compact
        ? Object.values(state.thoughts).join("\n").slice(-1000)
        : "";
    const preview = [thought ? "💭 " + thought : "", tools, text.slice(-2500)]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 3900);
    if (!preview || preview === state.last || (state.at && this.now() - state.at < 1500)) return;
    await this.deliver(topic, run, state, preview);
  }
  async finish(topic: FleetTopic, run: string, text: string): Promise<boolean> {
    const state = this.get(run);
    if (!state.message && ["SENDING", "RECONCILIATION_REQUIRED"].includes(state.delivery ?? ""))
      throw new TelegramDeliveryError("ambiguous");
    if (!state.message) return false;
    if (state.last !== text) await this.deliver(topic, run, state, text);
    return true;
  }
  private async deliver(
    topic: FleetTopic,
    run: string,
    state: Preview,
    text: string,
  ): Promise<void> {
    const editing = !!state.message;
    state.delivery = "SENDING";
    this.save(run, state);
    try {
      const result = await this.telegram.call<{ message_id: number }>(
        editing ? "editMessageText" : "sendMessage",
        {
          chat_id: topic.chatId,
          ...(editing ? { message_id: state.message } : { message_thread_id: topic.threadId }),
          text,
        },
      );
      if (!editing) state.message = result.message_id;
      state.delivery = "DELIVERED";
      state.last = text;
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
