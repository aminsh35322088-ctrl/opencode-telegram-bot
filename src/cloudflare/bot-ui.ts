import {
  createMainInlineKeyboard,
  createMainKeyboard,
  createTopicKeyboard,
  MAIN_BUTTONS,
} from "../bot/keyboards/main-reply-keyboard.js";
import { BOT_COMMANDS } from "../bot/commands/definitions.js";
import { t } from "../i18n/index.js";
import { CloudTelegram, TelegramDeliveryError } from "./telegram.js";
import {
  AGENT_MODE_BUTTON_TEXT_PATTERN,
  CONTEXT_BUTTON_TEXT_PATTERN,
  VARIANT_BUTTON_TEXT_PATTERN,
  QUEUED_PROMPT_BUTTON_TEXT_PATTERN,
} from "../bot/message-patterns.js";
import { CloudTaskUi } from "./task-ui.js";
import type { ProtectedTelegramUpdate } from "./credential-vault.js";
import { CloudConfigUi, resetGlobalConfiguration } from "./config-ui.js";
import type { AllocationJob, ControlStore, FleetTopic, SqlDatabase } from "./control-store.js";

export interface TelegramUpdate {
  update_id?: number;
  message?: {
    message_id?: number;
    text?: string;
    caption?: string;
    message_thread_id?: number;
    chat: { id: number };
    from?: { id: number };
    photo?: unknown[];
    document?: unknown;
    voice?: unknown;
    audio?: unknown;
    forum_topic_closed?: unknown;
    forum_topic_deleted?: unknown;
  };
  callback_query?: {
    id?: string;
    data?: string;
    from: { id: number };
    message?: { message_id?: number; message_thread_id?: number; chat: { id: number } };
  };
}
interface UiAction {
  action: string;
  value?: string;
  targetRun?: string;
}
interface UiOptions {
  compact?: boolean;
  compactOutputMode?: boolean;
  showThinkingContent?: boolean;
  responseStreamingMode?: string;
  messageFormatMode?: string;
  showAssistantRunFooter?: boolean;
  sendDiffFileAttachments?: boolean;
  promptQueueEnabled?: boolean;
  imageModel?: string;
  voiceModel?: string;
  model?: string;
  agent?: string;
  variant?: string;
  paused?: boolean;
  title?: string;
}
interface UiDependencies {
  sql: SqlDatabase;
  store: ControlStore;
  telegram: CloudTelegram;
  coreVersion: string;
  newTopic: (chat: number, request: string) => Promise<AllocationJob>;
  deleteTopic: (chat: number, thread: number) => Promise<void>;
  cancelAllocation?: (jobId: string) => Promise<void>;
  rpc: <T = unknown>(topic: FleetTopic, operation: string, payload?: unknown) => Promise<T>;
  global: (data: Record<string, unknown>, expectedRevision: number) => Promise<void>;
  saveCredential?: (
    update: ProtectedTelegramUpdate,
    providerId: string,
    generation: number,
  ) => Promise<void>;
  questionDecision?: (
    topic: FleetTopic,
    requestId: string,
    questions: unknown[],
    answers: string[][],
  ) => void;
}
type Button = { text: string; callback_data: string };
const normalized = (text: string) =>
  text
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF\uFE0F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
const escape = (value: unknown) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Telegram-only application adapter. State lives in the existing canonical SQLite DO.
 * Runtime behavior is delegated to Core; General never calls execution RPC. */
export class CloudBotUi {
  constructor(private readonly deps: UiDependencies) {}
  private get<T>(key: string): T | undefined {
    const row = [
      ...this.deps.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key=?", key),
    ][0];
    return row ? (JSON.parse(row.data) as T) : undefined;
  }
  private set(key: string, value: unknown): void {
    this.deps.sql.exec(
      "INSERT INTO ui_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
      key,
      JSON.stringify(value),
    );
  }
  options(topic: FleetTopic): UiOptions {
    return {
      ...(record(this.deps.store.global()?.data.defaults) as UiOptions),
      ...this.get<UiOptions>(
        "topic:" + topic.chatId + ":" + topic.threadId + ":" + topic.generation,
      ),
    };
  }
  private setOptions(topic: FleetTopic, patch: UiOptions): void {
    this.assertTopic(topic);
    if (patch.compact !== undefined) patch.compactOutputMode = patch.compact;
    else if (patch.compactOutputMode !== undefined) patch.compact = patch.compactOutputMode;
    this.set("topic:" + topic.chatId + ":" + topic.threadId + ":" + topic.generation, {
      ...this.get<UiOptions>(
        "topic:" + topic.chatId + ":" + topic.threadId + ":" + topic.generation,
      ),
      ...patch,
    });
  }
  private assertTopic(topic: FleetTopic): void {
    if (
      !this.deps.store
        .topics()
        .some(
          (t) =>
            t.chatId === topic.chatId &&
            t.threadId === topic.threadId &&
            t.generation === topic.generation &&
            t.state === "ACTIVE",
        )
    )
      throw new Error("stale_generation");
  }
  private model(topic?: FleetTopic): string {
    return (
      (topic && this.options(topic).model) ||
      String(record(record(this.deps.store.global()?.data.configuration).runtime).model ?? "")
    );
  }
  private button(
    actor: number,
    chat: number,
    thread: number,
    topic: FleetTopic | undefined,
    text: string,
    action: string,
    value?: string,
  ): Button {
    const id = crypto.randomUUID().replace(/-/g, "");
    this.deps.sql.exec(
      "INSERT INTO ui_callbacks(id,actor,chat,thread,generation,expires,data) VALUES(?,?,?,?,?,?,?)",
      id,
      actor,
      chat,
      thread,
      topic?.generation ?? 0,
      Date.now() + 30 * 60_000,
      JSON.stringify({ action, value }),
    );
    return { text, callback_data: "ui:" + id };
  }
  private async menu(
    chat: number,
    thread: number | undefined,
    text: string,
    rows: Button[][],
  ): Promise<void> {
    await this.deps.telegram.call("sendMessage", {
      chat_id: chat,
      ...(thread ? { message_thread_id: thread } : {}),
      text: text.slice(0, 4000),
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: rows },
    });
  }
  private async notice(chat: number, thread: number | undefined, text: string): Promise<void> {
    await this.deps.telegram.send(chat, thread, text);
  }
  async rpcDiff(topic: FleetTopic): Promise<unknown> {
    return this.deps.rpc(topic, "session.diff");
  }
  async keyboard(chat: number, topic?: FleetTopic, text = "OpenCode"): Promise<void> {
    const selected = this.model(topic),
      split = selected.indexOf("/");
    const currentModel = {
      providerID: selected.slice(0, split),
      modelID: selected.slice(split + 1),
    };
    const options = topic ? this.options(topic) : {};
    const keyboard = topic
      ? createTopicKeyboard({
          compactOutputMode: options.compact ?? options.compactOutputMode ?? false,
          paused: options.paused ?? false,
          running: this.deps.store.activeRuns(chat, topic.threadId).length > 0,
          currentModel,
        })
      : createMainKeyboard(currentModel);
    await this.deps.telegram.call("sendMessage", {
      chat_id: chat,
      ...(topic ? { message_thread_id: topic.threadId } : {}),
      text,
      reply_markup: keyboard,
    });
  }
  async runKeyboard(topic: FleetTopic, runId: string, running: boolean): Promise<void> {
    this.assertTopic(topic);
    if (!running && !this.deps.store.activeRuns(topic.chatId, topic.threadId).length)
      this.setOptions(topic, { paused: false });
    const id = "keyboard:" + runId + ":" + (running ? "active" : "idle");
    const receipt = [
      ...this.deps.sql.exec<{ state: string }>("SELECT state FROM ui_delivery WHERE id=?", id),
    ][0];
    if (receipt && receipt.state !== "PENDING") return;
    this.deps.sql.exec(
      "INSERT INTO ui_delivery VALUES(?,'SENDING',NULL) ON CONFLICT(id) DO UPDATE SET state='SENDING'",
      id,
    );
    try {
      await this.keyboard(topic.chatId, topic, running ? "▶ OpenCode is running…" : "✅ Ready");
      this.deps.sql.exec("UPDATE ui_delivery SET state='DELIVERED' WHERE id=?", id);
    } catch (error) {
      this.deps.sql.exec(
        "UPDATE ui_delivery SET state=? WHERE id=?",
        error instanceof TelegramDeliveryError && error.category === "rate_limited"
          ? "PENDING"
          : "RECONCILIATION_REQUIRED",
        id,
      );
    }
  }
  async ready(topic: FleetTopic): Promise<void> {
    const id = "ready:" + topic.workerId + ":" + topic.generation;
    const previous = [
      ...this.deps.sql.exec<{ state: string }>("SELECT state FROM ui_delivery WHERE id=?", id),
    ][0];
    if (previous && previous.state !== "PENDING") return; // Retry only a known not-sent rejection.
    this.deps.sql.exec(
      "INSERT INTO ui_delivery VALUES(?,'SENDING',NULL) ON CONFLICT(id) DO UPDATE SET state='SENDING'",
      id,
    );
    try {
      await this.keyboard(
        topic.chatId,
        topic,
        t("new.created", { title: this.options(topic).title ?? "OpenCode" }, "en"),
      );
      this.deps.sql.exec("UPDATE ui_delivery SET state='DELIVERED' WHERE id=?", id);
    } catch (error) {
      this.deps.sql.exec(
        "UPDATE ui_delivery SET state=? WHERE id=?",
        error instanceof TelegramDeliveryError && error.category === "rate_limited"
          ? "PENDING"
          : "RECONCILIATION_REQUIRED",
        id,
      );
      throw error;
    }
  }
  private async home(chat: number): Promise<void> {
    await this.deps.telegram.call("setMyCommands", {
      commands: BOT_COMMANDS,
      scope: { type: "chat", chat_id: chat },
    });
    await this.deps.telegram.call("sendMessage", {
      chat_id: chat,
      text: "OpenCode\nCore " + this.deps.coreVersion,
      reply_markup: createMainInlineKeyboard({ providerID: "", modelID: "" }),
    });
    await this.keyboard(chat);
  }
  private async settings(
    actor: number,
    chat: number,
    thread: number,
    topic?: FleetTopic,
  ): Promise<void> {
    const b = (label: string, action: string, value?: string) =>
      this.button(actor, chat, thread, topic, label, action, value);
    if (topic) {
      await this.menu(chat, thread, "🧵 <b>Topic Settings</b>\n\n" + escape(this.model(topic)), [
        [b("🧠 Models", "models")],
        [b("🧑‍💻 Agent", "agent")],
        [b("🎛 Variant", "variant")],
        [b("💬 Response & Output", "appearance")],
        [b("📥 Prompt Queue", "queue")],
        [b("🧠 Context Health", "context")],
        [b("🧭 Session", "session")],
        [b("✖ Close", "close")],
      ]);
    } else
      await this.menu(chat, undefined, "⚙️ <b>Settings</b>", [
        [b("🧠 Model Center", "models")],
        [b("🔌 Providers", "providers")],
        [b("🐙 GitHub", "github"), b("🌐 Tailscale", "tailscale")],
        [b("🧩 Extensions", "extensions")],
        [b("⚡ Actions", "actions")],
        [b("⋯ More", "more")],
      ]);
  }
  private async history(actor: number, chat: number): Promise<void> {
    const topics = this.deps.store
      .topics()
      .filter((t) => t.chatId === chat && t.state === "ACTIVE");
    const rows = topics.map((topic) => [
      this.button(
        actor,
        chat,
        0,
        undefined,
        this.options(topic).title ?? "OpenCode · " + topic.threadId,
        "open_topic",
        String(topic.threadId),
      ),
    ]);
    rows.push(
      [{ text: MAIN_BUTTONS.newChat, callback_data: "main:new" }],
      [{ text: "← Home", callback_data: "main:home" }],
    );
    await this.menu(
      chat,
      undefined,
      "🕘 <b>History</b>\n\n" +
        (topics.length
          ? "Choose a Topic to continue its dedicated session."
          : "No active AI Topics."),
      rows,
    );
  }
  private async confirm(
    actor: number,
    chat: number,
    thread: number,
    topic: FleetTopic | undefined,
    action: string,
    title: string,
  ): Promise<void> {
    await this.menu(
      chat,
      thread || undefined,
      "⚠️ <b>" +
        escape(title) +
        "</b>\n\nThis deletes Topic runtime state and files. This cannot be undone.",
      [
        [this.button(actor, chat, thread, topic, "🗑️ " + title, action)],
        [this.button(actor, chat, thread, topic, "Cancel", "close")],
      ],
    );
  }
  async handle(update: TelegramUpdate, updateId: number): Promise<boolean> {
    const message = update.message ?? update.callback_query?.message;
    const chat = message?.chat.id,
      actor = update.message?.from?.id ?? update.callback_query?.from.id;
    if (!chat || !actor) return true;
    const thread =
      message?.message_thread_id && message.message_thread_id > 1 ? message.message_thread_id : 0;
    const topic = this.deps.store
      .topics()
      .find((t) => t.chatId === chat && t.threadId === thread && t.state === "ACTIVE");
    const text = update.message?.text ?? "";
    const actionKey = "action:" + updateId;
    const saved = this.get<{
      actor: number;
      chat: number;
      thread: number;
      generation: number;
      action: UiAction;
    }>(actionKey);
    if (saved && (saved.actor !== actor || saved.chat !== chat || saved.thread !== thread))
      throw new Error("ui_scope_mismatch");
    let action: UiAction | undefined = saved?.action;
    const protectedInput = (update as ProtectedTelegramUpdate).credentialInput;
    if (protectedInput) action = { action: "credential_save", value: protectedInput.providerId };
    if (update.callback_query && !saved) {
      try {
        await this.deps.telegram.call("answerCallbackQuery", {
          callback_query_id: update.callback_query.id,
        });
      } catch {
        /* A replayed/expired callback must still reconcile its durable action. */
      }
      const data = update.callback_query.data ?? "";
      if (data.startsWith("ui:")) {
        const row = [
          ...this.deps.sql.exec<{
            actor: number;
            chat: number;
            thread: number;
            generation: number;
            expires: number;
            data: string;
            state: string;
          }>("SELECT * FROM ui_callbacks WHERE id=?", data.slice(3)),
        ][0];
        if (
          !row ||
          row.actor !== actor ||
          row.chat !== chat ||
          row.thread !== thread ||
          row.expires < Date.now() ||
          row.state !== "READY" ||
          row.generation !== (topic?.generation ?? 0)
        ) {
          await this.notice(
            chat,
            thread || undefined,
            "This menu has expired. Open the menu again.",
          );
          return true;
        }
        action = JSON.parse(row.data) as UiAction;
        // Commit ownership before I/O; retries cannot repeat a destructive operation.
        this.deps.sql.exec(
          "UPDATE ui_callbacks SET state='CLAIMED' WHERE id=? AND state='READY'",
          data.slice(3),
        );
      } else if (
        ["main:new", "main:home", "main:history", "main:settings"].includes(data) &&
        !thread
      ) {
        action = { action: data.slice(5) };
      } else {
        await this.notice(chat, thread || undefined, "This menu has expired. Open the menu again.");
        return true;
      }
    } else if (!saved && !protectedInput) {
      const label = normalized(text);
      const labels: Record<string, string> = {
        [normalized(MAIN_BUTTONS.newChat)]: "new",
        [normalized(MAIN_BUTTONS.history)]: "history",
        [normalized(MAIN_BUTTONS.mainSettings)]: "settings",
        [normalized(MAIN_BUTTONS.topicSettings)]: "topic_settings",
        [normalized(MAIN_BUTTONS.deleteChat)]: "delete_topic",
        [normalized(MAIN_BUTTONS.pause)]: "pause",
        [normalized(MAIN_BUTTONS.resume)]: "resume",
        [normalized(MAIN_BUTTONS.abort)]: "abort",
        [normalized(MAIN_BUTTONS.compact(true))]: "compact",
        [normalized(MAIN_BUTTONS.compact(false))]: "compact",
        "🧠 Models": "models",
        "🧠 Model Center": "models",
        "❌ Cancel": "close",
      };
      if (labels[label]) action = { action: labels[label]! };
      else if (AGENT_MODE_BUTTON_TEXT_PATTERN.test(label)) action = { action: "agent" };
      else if (CONTEXT_BUTTON_TEXT_PATTERN.test(label)) action = { action: "context" };
      else if (VARIANT_BUTTON_TEXT_PATTERN.test(label)) action = { action: "variant" };
      else if (QUEUED_PROMPT_BUTTON_TEXT_PATTERN.test(label)) action = { action: "queue" };
      else if (/^🧠 /.test(label)) action = { action: "models" };
      else if (text.startsWith("/")) {
        const match = /^\/([a-z_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text);
        action = { action: match?.[1] ?? "unknown", value: match?.[2] };
        if (
          action.action.endsWith("_confirm") ||
          action.action.endsWith("_final") ||
          action.action.startsWith("config_") ||
          action.action.startsWith("question_") ||
          action.action.startsWith("permission_")
        )
          action = { action: "unknown" };
      }
    }
    if (!action) {
      const formKey = "form:" + actor + ":" + chat + ":" + thread;
      const form = this.get<{ kind: string; generation: number; expires: number }>(formKey);
      if (form?.kind && form.expires <= Date.now()) {
        this.set(formKey, {});
        await this.notice(chat, thread || undefined, "This input form has expired. Open it again.");
        return true;
      }
      const hasMedia = !!(
        update.message?.photo ||
        update.message?.document ||
        update.message?.voice ||
        update.message?.audio
      );
      if (hasMedia && !form?.kind && thread) return false;
      if (hasMedia && form?.kind) {
        await this.notice(
          chat,
          thread || undefined,
          "This form needs a text answer. Send text, or /cancel.",
        );
        return true;
      }
      if (form && form.expires > Date.now()) {
        if (form.generation !== (topic?.generation ?? 0)) throw new Error("stale_generation");
        action = {
          action:
            form.kind === "open"
              ? "open"
              : form.kind.startsWith("config_")
                ? form.kind
                : form.kind + "_save",
          value: text,
        };
        this.set(actionKey, { actor, chat, thread, generation: topic?.generation ?? 0, action });
        this.set(formKey, {});
      } else if (!text || !thread) {
        await this.notice(
          chat,
          thread || undefined,
          "Use New Chat to open an AI Topic. General / ALL is for bot controls.",
        );
        return true;
      } else return false;
    }
    if (!saved) {
      if (["pause", "resume", "abort", "stop"].includes(action.action))
        action.targetRun = this.deps.store.activeRuns(chat, thread)[0]?.requestId;
      this.set(actionKey, { actor, chat, thread, generation: topic?.generation ?? 0, action });
    }
    const done = this.get<boolean>("action_done:" + updateId) === true;
    if (done) return true;
    if (
      saved &&
      saved.generation !== (topic?.generation ?? 0) &&
      !["delete_confirm"].includes(action.action)
    )
      throw new Error("stale_generation");
    const name = action.action;
    const mainOnly = [
      "new",
      "history",
      "home",
      "open_topic",
      "reset_history",
      "reset_history_confirm",
      "factory_reset",
      "factory_reset_confirm",
      "factory_reset_final",
    ];
    const topicOnly = [
      "keyboard",
      "topic_settings",
      "delete",
      "delete_topic",
      "delete_confirm",
      "pause",
      "resume",
      "abort",
      "stop",
      "session",
      "messages",
      "context",
      "compact",
      "agent",
      "variant",
      "rename",
      "rename_save",
      "ls",
      "open",
      "worktree",
      "detach",
      "opencode_start",
      "opencode_stop",
      "todos",
      "diff",
      "children",
      "child_messages",
      "file_download",
    ];
    if (
      (mainOnly.includes(name) && thread) ||
      (topicOnly.includes(name) && !topic && !(saved && name === "delete_confirm"))
    ) {
      await this.notice(
        chat,
        thread || undefined,
        thread ? "This control belongs in General / ALL." : "Open an AI Topic to use this control.",
      );
      return true;
    }
    if (name === "credential_save") {
      if (!protectedInput || !this.deps.saveCredential) throw new Error("invalid_credential_input");
      if (
        protectedInput.expires <= Date.now() ||
        protectedInput.generation !== (topic?.generation ?? 0)
      ) {
        this.set("action_done:" + updateId, true);
        this.set("form:" + actor + ":" + chat + ":" + thread, {});
        if (update.message?.message_id) {
          try {
            await this.deps.telegram.call("deleteMessage", {
              chat_id: chat,
              message_id: update.message.message_id,
            });
          } catch {
            /* Do not echo sensitive input. */
          }
        }
        await this.notice(
          chat,
          thread || undefined,
          "This credential form expired. Open Providers to connect again.",
        );
        return true;
      }
      await this.deps.saveCredential(
        update as ProtectedTelegramUpdate,
        protectedInput.providerId,
        topic?.generation ?? 0,
      );
      this.set("form:" + actor + ":" + chat + ":" + thread, {});
      this.set("action_done:" + updateId, true);
      if (update.message?.message_id) {
        try {
          await this.deps.telegram.call("deleteMessage", {
            chat_id: chat,
            message_id: update.message.message_id,
          });
        } catch {
          /* Never echo credentials on deletion failure. */
        }
      }
      await this.notice(chat, thread || undefined, "✅ Provider credential stored securely.");
      return true;
    }
    if (name === "start" || name === "home") {
      if (topic) await this.keyboard(chat, topic, "OpenCode Core " + this.deps.coreVersion);
      else await this.home(chat);
      return true;
    }
    if (name === "keyboard") {
      await this.keyboard(chat, topic);
      return true;
    }
    if (name === "new" || name === "new_chat") {
      const pending = this.deps.store
        .jobs()
        .find(
          (j) =>
            j.chatId === chat &&
            !["BOUND", "FAILED", "RECONCILIATION_REQUIRED"].includes(j.phase) &&
            !j.error,
        );
      const job = pending ?? (await this.deps.newTopic(chat, "telegram_" + updateId));
      await this.notice(chat, job.threadId, t("bot.creating_session", undefined, "en"));
      return true;
    }
    if (name === "history" || name === "sessions") {
      await this.history(actor, chat);
      return true;
    }
    if (name === "settings" || name === "topic_settings" || name === "back") {
      await this.settings(actor, chat, thread, topic);
      return true;
    }
    if (name === "close" || name === "cancel") {
      this.set("form:" + actor + ":" + chat + ":" + thread, {});
      await this.notice(chat, thread || undefined, t("common.cancelled", undefined, "en"));
      return true;
    }
    if (name === "open_topic") {
      const target = this.deps.store
        .topics()
        .find(
          (t) => t.chatId === chat && t.threadId === Number(action.value) && t.state === "ACTIVE",
        );
      if (!target) throw new Error("topic_not_writable");
      await this.keyboard(chat, target, "Continue this session here.");
      return true;
    }
    if (["delete", "delete_topic"].includes(name)) {
      await this.confirm(actor, chat, thread, topic, "delete_confirm", "Delete Chat");
      return true;
    }
    if (name === "delete_confirm") {
      await this.deps.deleteTopic(chat, thread);
      await this.deps.telegram.call("deleteForumTopic", {
        chat_id: chat,
        message_thread_id: thread,
      });
      this.set("action_done:" + updateId, true);
      return true;
    }
    if (name === "compact") {
      this.setOptions(topic!, {
        compact: !(this.options(topic!).compact ?? this.options(topic!).compactOutputMode),
      });
      this.set("action_done:" + updateId, true);
      await this.keyboard(chat, topic);
      return true;
    }
    if (["pause", "resume", "abort", "stop"].includes(name)) {
      const run = this.deps.store
        .activeRuns(chat, thread)
        .find((r) => r.requestId === action.targetRun);
      if (!run) {
        await this.notice(chat, thread, "No active execution.");
        return true;
      }
      await this.deps.rpc(topic!, name === "abort" ? "stop" : name, { runId: run.requestId });
      this.assertTopic(topic!);
      if (["stop", "abort"].includes(name)) {
        const status = await this.deps.rpc(topic!, "status");
        if (status) throw new Error("execution_cleanup_pending");
        this.deps.store.failRun(chat, thread, run.requestId, "🛑 Execution stopped.");
        this.setOptions(topic!, { paused: false });
      } else this.setOptions(topic!, { paused: name === "pause" });
      this.set("action_done:" + updateId, true);
      await this.keyboard(chat, topic);
      return true;
    }
    if (name === "rename") {
      if (action.value)
        return this.handleAction(
          actor,
          chat,
          thread,
          topic,
          { action: "rename_save", value: action.value },
          updateId,
        );
      this.set("form:" + actor + ":" + chat + ":" + thread, {
        kind: "rename",
        generation: topic!.generation,
        expires: Date.now() + 300000,
      });
      await this.notice(chat, thread, "Send the new Topic name, or /cancel.");
      return true;
    }
    if (name === "rename_save") {
      const title = (action.value ?? "").trim();
      if (!title || title.length > 128) throw new Error("invalid_topic_title");
      if (topic && !this.deps.store.worker(topic.workerId)?.runtimeVersion?.endsWith("pre.23"))
        await this.deps.rpc(topic, "session.rename", { title });
      await this.deps.telegram.call("editForumTopic", {
        chat_id: chat,
        message_thread_id: thread,
        name: title,
      });
      this.setOptions(topic!, { title });
      this.set("action_done:" + updateId, true);
      await this.notice(chat, thread, "✅ Topic renamed.");
      return true;
    }
    if (name === "status" || name === "session" || name === "context" || name === "messages") {
      if (!topic) {
        await this.notice(
          chat,
          undefined,
          "Cloudflare Control Plane is healthy.\nAI Topics: " +
            this.deps.store.topics().filter((t) => t.chatId === chat && t.state === "ACTIVE")
              .length +
            "\nCore " +
            this.deps.coreVersion,
        );
        return true;
      }
      const result = await this.deps.rpc(
        topic,
        name === "messages" || name === "context" ? "session.messages" : "session.get",
      );
      this.assertTopic(topic);
      if (name === "messages" && Array.isArray(result)) {
        for (const item of result.slice(-10)) {
          const parts = record(item).parts;
          const content = Array.isArray(parts)
            ? parts
                .filter((p) => record(p).type === "text")
                .map((p) => String(record(p).text ?? ""))
                .join("\n")
            : "";
          if (content)
            await this.notice(
              chat,
              thread,
              String(record(record(item).info).role ?? "") + "\n" + content.slice(0, 12000),
            );
        }
        if (!result.length) await this.notice(chat, thread, "No messages yet.");
      } else
        await this.menu(
          chat,
          thread,
          (name === "context" ? "📊 <b>Context Health</b>\n" : "🧭 <b>Session</b>\n") +
            escape(topic.sessionId) +
            "\nModel: " +
            escape(this.model(topic)) +
            "\n" +
            (Array.isArray(result)
              ? "Messages: " + result.length
              : "Title: " + escape(record(result).title)),
          [
            [this.button(actor, chat, thread, topic, "🕘 Messages", "messages")],
            [
              this.button(actor, chat, thread, topic, "☑ Tasks", "todos"),
              this.button(actor, chat, thread, topic, "📝 Changes", "diff"),
            ],
            [
              this.button(actor, chat, thread, topic, "🤖 Sub-agents", "children"),
              this.button(actor, chat, thread, topic, "📁 Files", "ls"),
            ],
            [this.button(actor, chat, thread, topic, "🏷 Rename", "rename")],
            [this.button(actor, chat, thread, topic, "← Topic Settings", "settings")],
          ],
        );
      return true;
    }
    if (["help", "update", "all"].includes(name)) {
      await this.notice(
        chat,
        thread || undefined,
        name === "help"
          ? BOT_COMMANDS.map((c) => "/" + c.command + " — " + c.description).join("\n")
          : "Cloudflare Control Plane\nOpenCode Core " +
              this.deps.coreVersion +
              "\nImmutable deployments are managed through the source-controlled release process.",
      );
      return true;
    }
    return this.handleAction(actor, chat, thread, topic, action, updateId);
  }
  async interactions(topic: FleetTopic, actor: number): Promise<void> {
    const run = this.deps.store.activeRuns(topic.chatId, topic.threadId)[0];
    if (!run) return;
    const questions = await this.deps.rpc<unknown[]>(topic, "question.list");
    if (Array.isArray(questions))
      for (const item of questions.slice(0, 8)) {
        const value = record(item),
          id = String(value.id ?? ""),
          list = value.questions;
        if (!id || !Array.isArray(list) || list.length > 16 || value.sessionID !== topic.sessionId)
          continue;
        const key = "question:" + topic.workerId + ":" + topic.generation + ":" + id;
        if (
          this.get<{ delivery?: string }>(key)?.delivery &&
          this.get<{ delivery?: string }>(key)?.delivery !== "PENDING"
        )
          continue;
        this.set(key, {
          delivery: "SENDING",
          runId: run.requestId,
          questions: list,
          answers: list.map(() => []),
          state: "PENDING",
        });
        try {
          await this.questionMenu(
            topic,
            actor,
            id,
            list,
            list.map(() => []),
          );
          this.set(key, { ...this.get<object>(key), delivery: "DELIVERED" });
        } catch (error) {
          this.set(key, {
            ...this.get<object>(key),
            delivery:
              error instanceof TelegramDeliveryError && error.category === "rate_limited"
                ? "PENDING"
                : "RECONCILIATION_REQUIRED",
          });
          throw error;
        }
      }
    // Old images have question transport but no permission DTO. Upgrade before polling it.
    const worker = this.deps.store.worker(topic.workerId);
    if (worker?.runtimeVersion && worker.runtimeVersion.endsWith("pre.23")) return;
    const permissions = await this.deps.rpc<unknown[]>(topic, "permission.list");
    if (Array.isArray(permissions))
      for (const item of permissions.slice(0, 8)) {
        const value = record(item),
          id = String(value.id ?? "");
        if (!id || value.sessionID !== topic.sessionId) continue;
        const key = "permission:" + topic.workerId + ":" + topic.generation + ":" + id;
        if (
          this.get<{ delivery?: string }>(key)?.delivery &&
          this.get<{ delivery?: string }>(key)?.delivery !== "PENDING"
        )
          continue;
        this.set(key, { delivery: "SENDING", runId: run.requestId, state: "PENDING" });
        try {
          await this.menu(
            topic.chatId,
            topic.threadId,
            "🔐 <b>Permission requested</b>\n" +
              escape(value.permission) +
              "\n" +
              escape(Array.isArray(value.patterns) ? value.patterns.join("\n").slice(0, 1500) : ""),
            [
              ["once", "always", "reject"].map((reply) =>
                this.button(
                  actor,
                  topic.chatId,
                  topic.threadId,
                  topic,
                  reply === "once" ? "Allow once" : reply === "always" ? "Always allow" : "Reject",
                  "permission_reply",
                  JSON.stringify({ id, reply }),
                ),
              ),
            ],
          );
          this.set(key, { ...this.get<object>(key), delivery: "DELIVERED" });
        } catch (error) {
          this.set(key, {
            ...this.get<object>(key),
            delivery:
              error instanceof TelegramDeliveryError && error.category === "rate_limited"
                ? "PENDING"
                : "RECONCILIATION_REQUIRED",
          });
          throw error;
        }
      }
  }
  private async questionMenu(
    topic: FleetTopic,
    actor: number,
    id: string,
    questions: unknown[],
    answers: string[][],
  ): Promise<void> {
    const rows: Button[][] = [],
      lines: string[] = ["❓ <b>Question</b>"];
    questions.forEach((item, index) => {
      const q = record(item);
      lines.push(escape(q.header), escape(q.question));
      if (answers[index]?.length) lines.push("Selected: " + escape(answers[index]!.join(", ")));
      for (const candidate of (Array.isArray(q.options) ? q.options : []).slice(0, 12)) {
        const option = record(candidate),
          label = String(option.label ?? "");
        rows.push([
          this.button(
            actor,
            topic.chatId,
            topic.threadId,
            topic,
            label.slice(0, 60),
            "question_choice",
            JSON.stringify({ id, index, label }),
          ),
        ]);
      }
      if (q.custom !== false)
        rows.push([
          this.button(
            actor,
            topic.chatId,
            topic.threadId,
            topic,
            "Custom answer · " + (index + 1),
            "question_custom",
            JSON.stringify({ id, index }),
          ),
        ]);
    });
    rows.push(
      [
        this.button(
          actor,
          topic.chatId,
          topic.threadId,
          topic,
          "Send answers",
          "question_submit",
          JSON.stringify({ id }),
        ),
      ],
      [
        this.button(
          actor,
          topic.chatId,
          topic.threadId,
          topic,
          "Dismiss",
          "question_reject",
          JSON.stringify({ id }),
        ),
      ],
    );
    await this.menu(topic.chatId, topic.threadId, lines.join("\n"), rows);
  }
  private async handleAction(
    actor: number,
    chat: number,
    thread: number,
    topic: FleetTopic | undefined,
    action: UiAction,
    updateId?: number,
  ): Promise<boolean> {
    if (action.action === "rename_save") {
      const title = (action.value ?? "").trim();
      if (!topic || !title || title.length > 128) throw new Error("invalid_topic_title");
      if (topic && !this.deps.store.worker(topic.workerId)?.runtimeVersion?.endsWith("pre.23"))
        await this.deps.rpc(topic, "session.rename", { title });
      await this.deps.telegram.call("editForumTopic", {
        chat_id: chat,
        message_thread_id: thread,
        name: title,
      });
      this.setOptions(topic, { title });
      if (updateId) this.set("action_done:" + updateId, true);
      await this.notice(chat, thread, "✅ Topic renamed.");
      return true;
    }
    const b = (label: string, name: string, value?: string) =>
      this.button(actor, chat, thread, topic, label, name, value);
    const global = this.deps.store.global();
    const name =
      action.action === "remember"
        ? "config_remember"
        : action.action === "forget"
          ? "config_forget"
          : action.action;
    const configUi = new CloudConfigUi({
      sql: this.deps.sql,
      store: this.deps.store,
      telegram: this.deps.telegram,
      commit: async (data, revision) => {
        await this.deps.global(data, revision);
        if (updateId) this.set("action_done:" + updateId, true);
      },
      button: b,
      notice: (text) => this.notice(chat, thread || undefined, text),
      menu: (text, rows) => this.menu(chat, thread || undefined, text, rows),
      prompt: async (kind, text) => {
        this.set("form:" + actor + ":" + chat + ":" + thread, {
          kind,
          generation: topic?.generation ?? 0,
          expires: Date.now() + 300000,
        });
        await this.notice(chat, thread || undefined, text);
      },
    });
    const prompt = async (kind: string, text: string) => {
      this.set("form:" + actor + ":" + chat + ":" + thread, {
        kind,
        generation: topic?.generation ?? 0,
        expires: Date.now() + 300000,
      });
      await this.notice(chat, thread || undefined, text);
    };
    const tasks = new CloudTaskUi({
      sql: this.deps.sql,
      store: this.deps.store,
      actorId: actor,
      chatId: chat,
      threadId: thread,
      generation: topic?.generation ?? 0,
      markCommitted: () => {
        if (updateId) this.set("action_done:" + updateId, true);
      },
      button: b,
      prompt,
      notice: (text) => this.notice(chat, thread || undefined, text),
      menu: (text, rows) => this.menu(chat, thread || undefined, text, rows),
    });
    if (await tasks.handle(name, action.value)) {
      if (updateId && name.startsWith("config_task_")) this.set("action_done:" + updateId, true);
      return true;
    }
    if (name === "config_credential_provider") {
      const providerId = action.value ?? "";
      if (
        !Object.hasOwn(
          record(record(record(global?.data.configuration).runtime).provider),
          providerId,
        )
      )
        throw new Error("provider_not_configured");
      this.set("form:" + actor + ":" + chat + ":" + thread, {
        kind: "credential",
        providerId,
        generation: topic?.generation ?? 0,
        expires: Date.now() + 300000,
      });
      await this.notice(
        chat,
        thread || undefined,
        "Send the provider API key. It will be encrypted before durable storage and never sent to a model. Use /cancel to cancel.",
      );
      return true;
    }
    if (topic && ["appearance", "queue", "config_topic_setting"].includes(name)) {
      const fields = [
        "compactOutputMode",
        "showThinkingContent",
        "messageFormatMode",
        "showAssistantRunFooter",
        "sendDiffFileAttachments",
        "promptQueueEnabled",
        "responseStreamingMode",
      ] as const;
      if (name === "config_topic_setting") {
        if (!fields.includes(action.value as (typeof fields)[number]))
          throw new Error("invalid_setting");
        const field = action.value as (typeof fields)[number];
        const current = this.options(topic)[field];
        this.setOptions(topic, {
          [field]:
            field === "responseStreamingMode"
              ? current === "off"
                ? "edit"
                : "off"
              : field === "messageFormatMode"
                ? current === "raw"
                  ? "markdown"
                  : "raw"
                : !current,
        });
        if (updateId) this.set("action_done:" + updateId, true);
      }
      const options = this.options(topic);
      await this.menu(
        chat,
        thread,
        "💬 <b>Response & Output</b>",
        fields
          .map((field) => [
            b(field + " · " + String(options[field] ?? false), "config_topic_setting", field),
          ])
          .concat([[b("← Topic Settings", "settings")]]),
      );
      return true;
    }
    if (name === "config_item_providers") {
      const runtime = record(record(global?.data.configuration).runtime),
        providers = record(runtime.provider);
      if (!action.value || !Object.hasOwn(providers, action.value))
        throw new Error("provider_not_configured");
      await this.menu(chat, thread || undefined, "🔌 <b>" + escape(action.value) + "</b>", [
        [b("🔐 Connect / Replace credential", "config_credential_provider", action.value)],
        [b("Toggle Enabled", "config_toggle_providers", action.value)],
        [b("Edit", "config_add_providers")],
        [b("Remove", "config_remove_providers", action.value)],
        [b("← Providers", "providers")],
      ]);
      return true;
    }
    if (await configUi.handle(name, action.value)) return true;
    if (name.startsWith("question_") || name.startsWith("permission_")) {
      if (!topic) throw new Error("topic_not_writable");
      const value = record(JSON.parse(action.value ?? "{}"));
      const id = String(value.id ?? "");
      const key =
        (name.startsWith("permission_") ? "permission:" : "question:") +
        topic.workerId +
        ":" +
        topic.generation +
        ":" +
        id;
      const pending = this.get<{
        runId: string;
        questions?: unknown[];
        answers?: string[][];
        state: string;
      }>(key);
      if (
        !pending ||
        pending.state !== "PENDING" ||
        !this.deps.store.activeRuns(chat, thread).some((r) => r.requestId === pending.runId)
      )
        throw new Error("interaction_expired");
      if (name === "permission_reply") {
        await this.deps.rpc(topic, "permission.reply", {
          runId: pending.runId,
          requestId: id,
          reply: value.reply,
        });
        this.set(key, { ...pending, state: "ANSWERED" });
        if (updateId) this.set("action_done:" + updateId, true);
        await this.notice(chat, thread, "✅ Permission answered.");
        return true;
      }
      if (name === "question_reject") {
        await this.deps.rpc(topic, "question.reject", { runId: pending.runId, requestId: id });
        this.set(key, { ...pending, state: "REJECTED" });
        if (updateId) this.set("action_done:" + updateId, true);
        await this.notice(chat, thread, "Question dismissed.");
        return true;
      }
      const questions = pending.questions ?? [];
      const index = Number(value.index);
      const question = record(questions[index]);
      const answers = pending.answers ?? questions.map(() => []);
      if (name === "question_choice") {
        const option = String(value.label);
        if (
          !Array.isArray(question.options) ||
          !question.options.some((o) => record(o).label === option)
        )
          throw new Error("invalid_answer");
        const selected = answers[index] ?? [];
        answers[index] = question.multiple
          ? selected.includes(option)
            ? selected.filter((s) => s !== option)
            : [...selected, option]
          : [option];
      } else if (name === "question_custom") {
        this.set("form:" + actor + ":" + chat + ":" + thread, {
          kind: "config_question_answer",
          generation: topic.generation,
          expires: Date.now() + 300000,
          id,
          index,
        });
        this.set("custom_question:" + actor + ":" + chat + ":" + thread, { id, index });
        await this.notice(chat, thread, "Send your answer, or /cancel.");
        return true;
      }
      this.set(key, { ...pending, answers });
      if (
        answers.every((a) => a.length) &&
        (name === "question_submit" || !questions.some((q) => record(q).multiple))
      ) {
        this.deps.questionDecision?.(topic, id, questions, answers);
        await this.deps.rpc(topic, "question.reply", {
          runId: pending.runId,
          requestId: id,
          answers,
        });
        this.set(key, { ...pending, answers, state: "ANSWERED" });
        if (updateId) this.set("action_done:" + updateId, true);
        await this.notice(chat, thread, "✅ Answer sent.");
      } else {
        if (updateId) this.set("action_done:" + updateId, true);
        await this.questionMenu(topic, actor, id, questions, answers);
      }
      return true;
    }
    if (name === "config_question_answer") {
      if (!topic) throw new Error("topic_not_writable");
      const custom = this.get<{ id: string; index: number }>(
        "custom_question:" + actor + ":" + chat + ":" + thread,
      );
      if (!custom) throw new Error("interaction_expired");
      const key = "question:" + topic.workerId + ":" + topic.generation + ":" + custom.id;
      const pending = this.get<{
        runId: string;
        questions: unknown[];
        answers: string[][];
        state: string;
      }>(key);
      if (
        !pending ||
        pending.state !== "PENDING" ||
        !this.deps.store.activeRuns(chat, thread).some((r) => r.requestId === pending.runId)
      )
        throw new Error("interaction_expired");
      if (!action.value?.trim() || action.value.length > 10000) throw new Error("invalid_answer");
      pending.answers[custom.index] = [action.value];
      this.set(key, pending);
      await this.questionMenu(topic, actor, custom.id, pending.questions, pending.answers);
      return true;
    }
    if (name === "file_download") {
      if (!topic || !action.value) throw new Error("topic_not_writable");
      const file = record(await this.deps.rpc(topic, "file.read", { path: action.value }));
      this.assertTopic(topic);
      const content =
        file.encoding === "base64"
          ? Uint8Array.from(atob(String(file.content)), (c) => c.charCodeAt(0))
          : String(file.content ?? "");
      const filename =
        action.value
          .split("/")
          .at(-1)!
          .replace(/[^A-Za-z0-9_.-]/g, "_")
          .slice(0, 128) || "file";
      await this.deps.telegram.document(chat, thread, filename, content);
      return true;
    }
    if (["todos", "diff", "children", "child_messages", "ls", "open"].includes(name)) {
      if (!topic) throw new Error("topic_not_writable");
      const operation = {
        todos: "session.todos",
        diff: "session.diff",
        children: "session.children",
        child_messages: "session.child-messages",
        ls: "file.list",
        open: "file.read",
      }[name]!;
      if (name === "open" && !action.value) {
        await prompt("open", "Send a relative workspace file path, or /cancel.");
        return true;
      }
      const payload =
        name === "ls" || name === "open"
          ? { path: action.value?.trim() || "." }
          : name === "child_messages"
            ? { childId: action.value }
            : undefined;
      const result = await this.deps.rpc(topic, operation, payload);
      this.assertTopic(topic);
      if (name === "ls") {
        const entries = Array.isArray(result) ? result : [];
        await this.menu(
          chat,
          thread,
          "📁 <b>Workspace files</b>",
          entries
            .slice(0, 60)
            .map((item) => {
              const entry = record(item),
                path = String(entry.path ?? entry.name ?? "");
              return [
                b(
                  (entry.type === "directory" ? "📁 " : "📄 ") + path.slice(0, 55),
                  entry.type === "directory" ? "ls" : "open",
                  path,
                ),
              ];
            })
            .concat([[b("← Session", "session")]]),
        );
      } else if (name === "children") {
        const children = Array.isArray(result) ? result : [];
        await this.menu(
          chat,
          thread,
          "🤖 <b>Sub-agents</b>\n" +
            (children.length
              ? "Choose a child session to inspect its messages."
              : "No sub-agent sessions."),
          children
            .slice(0, 30)
            .map((item) => [
              b(
                String(record(item).title ?? record(item).id).slice(0, 60),
                "child_messages",
                String(record(item).id),
              ),
            ])
            .concat([[b("← Session", "session")]]),
        );
      } else if (name === "open") {
        const file = record(result);
        if (file.encoding === "base64")
          await this.notice(chat, thread, "Binary file. Text preview is unavailable.");
        else await this.notice(chat, thread, String(file.content ?? "Empty file.").slice(0, 24000));
        await this.menu(chat, thread, "📄 <b>Workspace file</b>", [
          [b("⬇ Download", "file_download", action.value)],
          [b("← Files", "ls")],
        ]);
      } else if (name === "child_messages") {
        const entries = Array.isArray(result) ? result : [];
        for (const item of entries.slice(-10)) {
          const parts = record(item).parts;
          const text = Array.isArray(parts)
            ? parts
                .filter((p) => record(p).type === "text")
                .map((p) => String(record(p).text ?? ""))
                .join("\n")
            : "";
          if (text) await this.notice(chat, thread, text.slice(0, 12000));
        }
        if (!entries.length) await this.notice(chat, thread, "No child messages yet.");
      } else {
        const items = Array.isArray(result) ? result : [];
        const text =
          name === "todos"
            ? items
                .map((item) => {
                  const v = record(item);
                  return String(v.status ?? "pending") + " · " + String(v.content ?? "");
                })
                .join("\n")
            : items
                .map((item) => {
                  const v = record(item);
                  return (
                    String(v.path ?? v.file ?? "") +
                    " · +" +
                    String(v.additions ?? 0) +
                    " / -" +
                    String(v.deletions ?? 0)
                  );
                })
                .join("\n");
        await this.notice(
          chat,
          thread,
          text || (name === "todos" ? "No pending tasks." : "No workspace changes."),
        );
      }
      return true;
    }
    if (["worktree", "detach", "opencode_start", "opencode_stop"].includes(name)) {
      await this.notice(
        chat,
        thread || undefined,
        "This Topic owns a dedicated managed Core runtime and workspace. Use /session to inspect it, /abort to stop work, or Delete Chat to retire it. Runtime creation and cleanup are controlled by Cloudflare.",
      );
      return true;
    }
    if (name === "more" || name === "advanced") {
      await this.menu(chat, thread || undefined, "🧰 <b>More Settings</b>", [
        [b("🧩 Topic Defaults", "topic_defaults")],
        [b("🧠 Skills", "skills")],
        [b("🔗 MCP", "mcps")],
        [b("🧩 Plugins", "plugins")],
        [b("💾 Persistent Memory", "memory")],
        [b("🧩 Custom Commands", "commands")],
        [b("📅 Scheduled Tasks", "tasklist")],
        [b("🧪 Experimental", "experimental")],
        [b("🧹 Clear Conversation History", "reset_history")],
        [b("☢️ Factory Reset", "factory_reset")],
        [b("← Settings", "settings")],
      ]);
      return true;
    }
    if (
      name === "appearance" ||
      name === "queue" ||
      name === "topic_defaults" ||
      name === "experimental"
    ) {
      await this.menu(
        chat,
        thread || undefined,
        "💬 <b>Response & Output</b>\n\n" +
          (topic ? "Topic presentation settings." : "Defaults for new AI Topics."),
        [
          ...(topic
            ? [[b("📦 Compact: " + (this.options(topic).compact ? "ON" : "OFF"), "compact")]]
            : []),
          [b("← Settings", "settings")],
        ],
      );
      return true;
    }
    if (name === "github" || name === "tailscale") {
      const integrations = record(global?.data.integrations);
      const status = record(integrations[name]);
      await this.menu(
        chat,
        thread || undefined,
        (name === "github" ? "🐙 <b>GitHub</b>" : "🌐 <b>Tailscale</b>") +
          "\n\n" +
          (status.connected ? "Connected" : "Not connected") +
          "\n" +
          (name === "github"
            ? "Repository access belongs to the dedicated Core Worker. A scoped GitHub credential and governed Git transport must be configured before connecting."
            : "VPN, SSH and tailscaled run only on execution Workers. A scoped Tailscale credential and governed runtime connection are required."),
        [[b("← Settings", "settings")]],
      );
      return true;
    }
    if (name === "models" || name === "model") {
      let providers: unknown[] = [];
      if (topic) {
        const result = await this.deps.rpc(topic, "models.list");
        providers = Array.isArray(record(result).providers)
          ? (record(result).providers as unknown[])
          : [];
        this.set("models:catalog", { providers });
      } else providers = this.get<{ providers: unknown[] }>("models:catalog")?.providers ?? [];
      const modelRows: Button[][] = [];
      for (const item of providers) {
        const provider = record(item);
        for (const [id, model] of Object.entries(record(provider.models))) {
          if (modelRows.length >= 40) break;
          modelRows.push([
            b(
              String(provider.id) + "/" + String(record(model).name ?? id),
              "model_save",
              String(provider.id) + "/" + id,
            ),
          ]);
        }
      }
      await this.menu(
        chat,
        thread || undefined,
        "🧠 <b>Model Center</b>\n\nPrimary: " +
          escape(this.model(topic)) +
          "\nSet an exact provider/model. No hidden model fallback.",
        [
          [b("💬 Primary / Chat & Coding", "model_edit")],
          [b("🖼 Image Model", "model_image"), b("🎙 Voice Model", "model_voice")],
          ...modelRows,
          [b("🔌 Providers", "providers")],
          [b("← Settings", "settings")],
        ],
      );
      return true;
    }
    if (name === "agent" || name === "variant") {
      if (!topic) throw new Error("topic_not_writable");
      const catalog = await this.deps.rpc(topic, name === "agent" ? "agents.list" : "models.list");
      let names: string[] = [];
      if (name === "agent" && Array.isArray(catalog))
        names = catalog
          .filter((item) => !record(item).hidden && record(item).mode !== "subagent")
          .map((item) => String(record(item).name));
      if (name === "variant") {
        const selected = this.model(topic),
          split = selected.indexOf("/");
        const providers = record(catalog).providers;
        const provider = Array.isArray(providers)
          ? providers.find((item) => record(item).id === selected.slice(0, split))
          : undefined;
        const model = record(record(record(provider).models)[selected.slice(split + 1)]);
        if (Array.isArray(model.variants)) names = model.variants.map(String);
      }
      this.set("catalog:" + topic.workerId + ":" + topic.generation + ":" + name, names);
      await this.menu(
        chat,
        thread,
        (name === "agent" ? "🤖 <b>Agent</b>" : "🎛 <b>Variant</b>") +
          (names.length ? "" : "\nNo choices advertised by this runtime/model."),
        names
          .slice(0, 40)
          .map((value) => [b(value, name + "_save", value)])
          .concat([[b("← Topic Settings", "settings")]]),
      );
      return true;
    }
    if (name === "model_image" || name === "model_voice") {
      await prompt(
        name === "model_image" ? "config_image_model" : "config_voice_model",
        "Send the exact provider/model for " +
          (name === "model_image" ? "image attachments" : "audio attachments") +
          ", or /cancel. The provider must support this media type.",
      );
      return true;
    }
    if (name === "config_image_model" || name === "config_voice_model") {
      const selected = action.value?.trim() ?? "";
      if (!/^[^/\s]{1,128}\/.{1,128}$/.test(selected)) throw new Error("invalid_model");
      const field = name === "config_image_model" ? "imageModel" : "voiceModel";
      if (topic) this.setOptions(topic, { [field]: selected });
      else {
        if (!global) throw new Error("snapshot_unavailable");
        await this.deps.global(
          { ...global.data, defaults: { ...record(global.data.defaults), [field]: selected } },
          global.revision,
        );
      }
      if (updateId) this.set("action_done:" + updateId, true);
      await this.notice(
        chat,
        thread || undefined,
        "✅ Media model saved. Capability and credentials are checked before execution.",
      );
      return true;
    }
    if (name === "model_edit" || name === "agent" || name === "variant") {
      this.set("form:" + actor + ":" + chat + ":" + thread, {
        kind: name === "model_edit" ? "model" : name,
        generation: topic?.generation ?? 0,
        expires: Date.now() + 300000,
      });
      await this.notice(
        chat,
        thread || undefined,
        name === "model_edit"
          ? "Send the exact provider/model ID, or /cancel."
          : "Send the " + name + " name, or /cancel.",
      );
      return true;
    }
    if (name === "model_save") {
      const selected = action.value?.trim() ?? "";
      if (!/^[^/\s]{1,128}\/.{1,128}$/.test(selected)) throw new Error("invalid_model");
      if (!topic) {
        if (!global) throw new Error("snapshot_unavailable");
        const configuration = record(global.data.configuration);
        await this.deps.global(
          {
            ...global.data,
            configuration: {
              ...configuration,
              runtime: { ...record(configuration.runtime), model: selected },
            },
          },
          global.revision,
        );
      } else {
        if (this.deps.store.activeRuns(chat, thread).length) throw new Error("execution_active");
        const split = selected.indexOf("/");
        const inspection = await this.deps.rpc<{ connected: boolean; available: boolean }>(
          topic,
          "model.inspect",
          { providerID: selected.slice(0, split), modelID: selected.slice(split + 1) },
        );
        if (!inspection.connected || !inspection.available) throw new Error("model_unavailable");
        this.setOptions(topic, { model: selected });
      }
      if (updateId) this.set("action_done:" + updateId, true);
      await this.notice(chat, thread || undefined, "✅ Model saved: " + selected);
      return true;
    }
    if (name === "agent_save" || name === "variant_save") {
      if (!topic || this.deps.store.activeRuns(chat, thread).length)
        throw new Error("execution_active");
      const value = action.value?.trim() ?? "";
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(value)) throw new Error("invalid_selection");
      const choices = this.get<string[]>(
        "catalog:" + topic.workerId + ":" + topic.generation + ":" + name.replace("_save", ""),
      );
      if (!choices?.includes(value)) throw new Error("invalid_selection");
      this.setOptions(topic, name === "agent_save" ? { agent: value } : { variant: value });
      if (updateId) this.set("action_done:" + updateId, true);
      await this.notice(chat, thread, "✅ Selection saved.");
      return true;
    }
    if (name === "factory_reset_confirm") {
      await this.confirm(actor, chat, thread, topic, "factory_reset_final", "Final Factory Reset");
      return true;
    }
    if (name === "reset_history_confirm" || name === "factory_reset_final") {
      this.set("reset:" + chat, { updateId });
      for (const job of this.deps.store
        .jobs()
        .filter((j) => j.chatId === chat && !["BOUND", "FAILED"].includes(j.phase))) {
        if (!this.deps.cancelAllocation) throw new Error("pending_worker_cleanup_required");
        await this.deps.cancelAllocation(job.jobId);
        if (job.threadId)
          await this.deps.telegram.call("deleteForumTopic", {
            chat_id: chat,
            message_thread_id: job.threadId,
          });
      }
      const key = "cleanup:" + updateId;
      let plan = this.get<Array<{ threadId: number; deleted?: boolean }>>(key);
      if (!plan) {
        plan = this.deps.store
          .topics()
          .filter((t) => t.chatId === chat)
          .map((t) => ({ threadId: t.threadId }));
        this.set(key, plan);
      }
      for (const target of plan) {
        if (target.deleted) continue;
        await this.deps.deleteTopic(chat, target.threadId);
        await this.deps.telegram.call("deleteForumTopic", {
          chat_id: chat,
          message_thread_id: target.threadId,
        });
        target.deleted = true;
        this.set(key, plan);
      }
      if (name === "factory_reset_final") {
        const current = this.deps.store.global();
        if (!current) throw new Error("snapshot_unavailable");
        await this.deps.global(resetGlobalConfiguration(current.data), current.revision);
        this.deps.sql.exec(
          "DELETE FROM ui_state WHERE key LIKE 'credential:%' OR key LIKE 'form:%' OR key LIKE 'task:%'",
        );
      }
      if (updateId) this.set("action_done:" + updateId, true);
      this.deps.sql.exec("DELETE FROM ui_state WHERE key=?", "reset:" + chat);
      await this.notice(
        chat,
        undefined,
        "✅ " +
          (name === "factory_reset_final" ? "Factory Reset" : "Conversation history cleared") +
          " completed.",
      );
      return true;
    }
    if (name === "reset_history" || name === "factory_reset") {
      await this.confirm(
        actor,
        chat,
        thread,
        topic,
        name + "_confirm",
        name === "reset_history" ? "Clear Conversation History" : "Factory Reset",
      );
      return true;
    }
    await this.notice(
      chat,
      thread || undefined,
      "Unknown or unavailable command. Use /help for the command list.",
    );
    return true;
  }
}
