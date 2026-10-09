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
import { CloudTaskUi, taskDraftKey } from "./task-ui.js";
import type { ProtectedTelegramUpdate } from "./credential-vault.js";
import { CloudConfigUi, resetGlobalConfiguration, OUTPUT_DEFAULTS } from "./config-ui.js";
import type { AllocationJob, ControlStore, FleetTopic, SqlDatabase } from "./control-store.js";
import { LegacyUiAdapter } from "./legacy-ui-adapter.js";
import { LegacyMainUi, renderLegacyMainStatus } from "./legacy-main-ui.js";
import { LegacyModelAdapter, type LegacyModelScope } from "./legacy-model-adapter.js";
import { LegacySessionAdapter } from "./legacy-session-adapter.js";
import {
  SESSION_DASHBOARD_CHILD_PREFIX,
  SESSION_DASHBOARD_CHILDREN,
  SESSION_DASHBOARD_DIFF,
  SESSION_DASHBOARD_FILES,
  SESSION_DASHBOARD_MESSAGES,
  SESSION_DASHBOARD_RENAME,
  SESSION_DASHBOARD_SETTINGS,
  SESSION_DASHBOARD_TODOS,
  buildSessionChildrenView,
  buildSessionDashboardView,
  buildSessionDiffView,
  buildSessionTodosView,
} from "../bot/menus/session-dashboard-menu.js";
import {
  buildMessageReadOnlyDetailKeyboard,
  buildMessagesListKeyboard,
  formatMessageDetailText,
  formatMessagesSelectText,
  parseMessagePageCallback,
  parseMessageSelectCallback,
} from "../bot/menus/message-history-menu.js";
import {
  LS_CALLBACK_BACK_PREFIX,
  LS_CALLBACK_DOWNLOAD_PREFIX,
  LS_CALLBACK_FILE_PREFIX,
  LS_CALLBACK_NAV_PREFIX,
  buildRemoteLsBrowseView,
  buildRemoteLsFileView,
} from "../bot/menus/file-browser-menu.js";
import { buildCanonicalContextControlView } from "../bot/menus/context-control-menu.js";
import {
  MODEL_CENTER_FAVORITES,
  MODEL_CENTER_PROVIDER_PREFIX,
  MODEL_CENTER_PROVIDERS,
  MODEL_CENTER_RECENT,
  MODEL_CENTER_ROOT,
  MODEL_CENTER_SEARCH,
  MODEL_CENTER_SEARCH_AGAIN,
  MODEL_CENTER_SELECT_PREFIX,
  MODEL_CENTER_FAVORITE_PREFIX,
  MODEL_CENTER_SETTINGS_BACK,
  buildModelCenterList,
  buildModelCenterProvider,
  buildModelCenterProviders,
  buildModelCenterRoot,
  buildModelCenterSearchResults,
  resolveModelCenterAction,
} from "../bot/menus/model-center-menu.js";
import {
  SETTINGS_ACTIONS_CALLBACK,
  SETTINGS_EXTENSIONS_CALLBACK,
  SETTINGS_GITHUB_CALLBACK,
  SETTINGS_MORE_CALLBACK,
} from "../bot/menus/extension-settings-menu.js";
import {
  SETTINGS_ADVANCED_CALLBACK,
  SETTINGS_AGENT_CALLBACK,
  SETTINGS_APPEARANCE_CALLBACK,
  SETTINGS_ASSISTANT_FOOTER_CALLBACK,
  SETTINGS_BACK_CALLBACK,
  SETTINGS_CLOSE_CALLBACK,
  SETTINGS_COMMANDS_CALLBACK,
  SETTINGS_COMPACT_OUTPUT_CALLBACK,
  SETTINGS_CONTEXT_CALLBACK,
  SETTINGS_DEFAULT_COMPACT_CALLBACK,
  SETTINGS_DEFAULT_DIFF_CALLBACK,
  SETTINGS_DEFAULT_FOOTER_CALLBACK,
  SETTINGS_DEFAULT_FORMAT_CALLBACK,
  SETTINGS_DEFAULT_MODELS_CALLBACK,
  SETTINGS_DEFAULT_QUEUE_CALLBACK,
  SETTINGS_DEFAULT_STREAMING_CALLBACK,
  SETTINGS_DEFAULT_THINKING_CALLBACK,
  SETTINGS_DIFF_FILES_CALLBACK,
  SETTINGS_EXPERIMENTAL_CALLBACK,
  SETTINGS_FACTORY_RESET_CALLBACK,
  SETTINGS_FREE_DETECTION_CALLBACK,
  SETTINGS_IMAGE_MODEL_CALLBACK,
  SETTINGS_MEMORY_CALLBACK,
  SETTINGS_MESSAGE_FORMAT_CALLBACK,
  SETTINGS_MODEL_CALLBACK,
  SETTINGS_NOTIFICATIONS_CALLBACK,
  SETTINGS_PROMPT_QUEUE_CALLBACK,
  SETTINGS_RESET_HISTORY_CALLBACK,
  SETTINGS_RESPONSE_STREAMING_CALLBACK,
  SETTINGS_THINKING_CONTENT_CALLBACK,
  SETTINGS_TOPIC_DEFAULTS_CALLBACK,
  SETTINGS_TOPIC_MODELS_CALLBACK,
  SETTINGS_VARIANT_CALLBACK,
  SETTINGS_VOICE_MODEL_CALLBACK,
  buildCanonicalAdvancedSettingsView,
  buildCanonicalAppearanceSettingsView,
  buildCanonicalExperimentalSettingsView,
  buildCanonicalMoreSettingsView,
  buildCanonicalPromptQueueSettingsView,
  buildCanonicalSettingsMenuView,
  buildCanonicalTopicDefaultsSettingsView,
  buildCanonicalTopicModelsSettingsView,
  type CanonicalTopicSettingsState,
} from "../bot/menus/settings-menu.js";

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
  panel?: boolean;
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
  titleSource?: "auto" | "manual";
}
interface UiDependencies {
  allowedUserId?: string;
  sql: SqlDatabase;
  store: ControlStore;
  telegram: CloudTelegram;
  coreVersion: string;
  legacyUi?: LegacyUiAdapter;
  compact?: (topic: FleetTopic, requestId: string) => Promise<void>;
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
type CallbackButton = { text: string; callback_data: string };
type Button = CallbackButton | { text: string; url: string };
interface NavigationTarget {
  action: string;
  value?: string;
}
interface NavigationSpec {
  back?: NavigationTarget;
  home?: boolean;
  strip?: string[];
}
const normalized = (text: string) =>
  text
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF\uFE0F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
const parentWorkspacePath = (value: string): string => {
  const normalizedPath = value
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  if (!normalizedPath || normalizedPath === ".") return ".";
  const separator = normalizedPath.lastIndexOf("/");
  return separator < 0 ? "." : normalizedPath.slice(0, separator) || ".";
};
const escape = (value: unknown) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function supportsContextCompaction(version: string | undefined): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)-bot\.(\d+)(?:-pre\.(\d+))?$/.exec(version ?? "");
  if (!match) return false;
  const parts = match
    .slice(1)
    .map((value, index) => (index === 4 && value === undefined ? Infinity : Number(value)));
  const minimum = [1, 18, 33, 13, 25];
  for (let index = 0; index < minimum.length; index++) {
    if (parts[index]! > minimum[index]!) return true;
    if (parts[index]! < minimum[index]!) return false;
  }
  return true;
}

interface PanelScope {
  actor: number;
  chat: number;
  thread: number;
  generation: number;
}
interface PanelState {
  clearKeyboard?: boolean;
  messageId?: number;
  state?: string;
  signature?: string;
  callbacks?: string[];
  revision?: number;
}
const navigation = new Set([
  "start",
  "home",
  "keyboard",
  "settings",
  "topic_settings",
  "back",
  "history",
  "sessions",
  "open_topic",
  "more",
  "models",
  "model",
  "model_favorites",
  "model_recent",
  "model_providers",
  "model_provider",
  "model_search",
  "topic_models",
  "advanced",
  "messages_page",
  "message_select",
  "child_messages",
  "open",
  "providers",
  "github",
  "tailscale",
  "extensions",
  "actions",
  "skills",
  "mcps",
  "plugins",
  "memory",
  "commands",
  "tasklist",
  "experimental",
  "topic_defaults",
  "appearance",
  "queue",
  "context",
  "session",
  "messages",
  "todos",
  "diff",
  "children",
  "agent",
  "variant",
  "ls",
  "close",
  "cancel",
  "config_item_providers",
  "config_item_skills",
  "config_item_mcps",
  "config_item_plugins",
  "config_item_actions",
  "config_item_commands",
]);

/** Telegram-only application adapter. State lives in the existing canonical SQLite DO.
 * Runtime behavior is delegated to Core; General never calls execution RPC. */
export class CloudBotUi {
  constructor(
    private readonly deps: UiDependencies,
    private readonly panelScope?: PanelScope,
  ) {}
  forPanel(actor: number, chat: number, thread: number, generation: number): CloudBotUi {
    return new CloudBotUi(this.deps, { actor, chat, thread, generation });
  }
  panelIdentity(
    actor: number,
    chat: number,
    thread: number,
    generation: number,
  ): { messageId?: number; state?: string } {
    const state = this.get<PanelState>(`panel:${actor}:${chat}:${thread}:${generation}`);
    return state ? { messageId: state.messageId, state: state.state } : {};
  }
  private adoptPanel(messageId: number | undefined): boolean {
    const scope = this.panelScope!;
    const key = `panel:${scope.actor}:${scope.chat}:${scope.thread}:${scope.generation}`;
    const current = this.get<PanelState>(key);
    if (current?.messageId) return true;
    if (current?.state || !Number.isSafeInteger(messageId) || !messageId || messageId < 1)
      return false;
    const owned = [
      ...this.deps.sql.exec<{ key: string; data: string }>(
        "SELECT key,data FROM ui_state WHERE key LIKE ?",
        `panel:%:${scope.chat}:${scope.thread}:${scope.generation}`,
      ),
    ].some((row) => row.key !== key && record(JSON.parse(row.data)).messageId === messageId);
    if (owned) return false;
    this.set(key, { messageId, state: "DELIVERED" });
    return true;
  }
  private async clearLegacyKeyboard(actor: number, chat: number): Promise<void> {
    const key = `keyboard-cleared:${actor}:${chat}`;
    let receipt = this.get<{ state: string; messageId?: number }>(key);
    if (receipt?.state === "CLEARED") return;
    if (
      !receipt?.messageId &&
      ["SENDING", "RECONCILIATION_REQUIRED"].includes(receipt?.state ?? "")
    )
      throw new TelegramDeliveryError("ambiguous");
    if (!receipt?.messageId) {
      this.set(key, { state: "SENDING" });
      try {
        const sent = await this.deps.telegram.call<{ message_id: number }>("sendMessage", {
          chat_id: chat,
          text: "⌨️ Updating controls…",
          disable_notification: true,
          reply_markup: { remove_keyboard: true },
        });
        receipt = { state: "DELIVERED", messageId: sent.message_id };
        this.set(key, receipt);
      } catch (error) {
        this.set(key, {
          state:
            error instanceof TelegramDeliveryError && error.category !== "ambiguous"
              ? "PENDING"
              : "RECONCILIATION_REQUIRED",
        });
        throw error;
      }
    }
    try {
      await this.deps.telegram.call("deleteMessage", {
        chat_id: chat,
        message_id: receipt.messageId,
      });
    } catch (error) {
      if (!(error instanceof TelegramDeliveryError) || error.reason !== "message_not_found")
        throw error;
    }
    this.set(key, { state: "CLEARED" });
  }
  private async panel(
    chat: number,
    thread: number | undefined,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const scope = this.panelScope;
    if (!scope || scope.chat !== chat || scope.thread !== (thread ?? 0)) {
      await this.deps.telegram.call("sendMessage", {
        chat_id: chat,
        ...(thread ? { message_thread_id: thread } : {}),
        ...payload,
      });
      return;
    }
    if (
      scope.thread &&
      scope.generation &&
      !this.deps.store
        .topics()
        .some(
          (topic) =>
            topic.chatId === chat &&
            topic.threadId === scope.thread &&
            topic.generation === scope.generation &&
            topic.state === "ACTIVE",
        )
    )
      throw new Error("stale_generation");
    const key = `panel:${scope.actor}:${chat}:${scope.thread}:${scope.generation}`;
    if (!scope.thread && !this.get<PanelState>(key)) {
      const legacy = this.legacyAdapter().getUiState<{ messageId: number; actorId?: number }>(
        `legacy:main:${chat}`,
      );
      if (legacy && (!legacy.actorId || legacy.actorId === scope.actor))
        this.adoptPanel(legacy.messageId);
    }
    let previous = this.get<PanelState>(key) ?? {};
    if (previous.clearKeyboard) {
      await this.clearLegacyKeyboard(scope.actor, chat);
      if (this.get<PanelState>(key)?.revision !== previous.revision) return;
      previous = { ...previous, clearKeyboard: false };
      this.set(key, previous);
    }
    const signature = JSON.stringify(payload);
    const markup = record(payload.reply_markup);
    const callbacks = Array.isArray(markup.inline_keyboard)
      ? markup.inline_keyboard
          .flat()
          .map((button) => String(record(button).callback_data ?? ""))
          .filter((id) => id.startsWith("ui:"))
          .map((id) => id.slice(3))
      : [];
    if (previous.signature === signature && previous.state === "DELIVERED") return;
    if (
      !previous.messageId &&
      ["SENDING", "RECONCILIATION_REQUIRED"].includes(previous.state ?? "")
    )
      throw new TelegramDeliveryError("ambiguous");
    const revision = (previous.revision ?? 0) + 1;
    this.set(key, { ...previous, state: "SENDING", callbacks, revision });
    try {
      const result = await this.deps.telegram.call<{ message_id: number }>(
        previous.messageId ? "editMessageText" : "sendMessage",
        {
          chat_id: chat,
          ...(previous.messageId
            ? { message_id: previous.messageId }
            : thread
              ? { message_thread_id: thread }
              : {}),
          ...payload,
        },
      );
      if (this.get<PanelState>(key)?.revision !== revision) return;
      this.set(key, {
        messageId: previous.messageId ?? result.message_id,
        revision,
        state: "DELIVERED",
        signature,
        callbacks,
      });
      if (!scope.thread) {
        const adapter = this.legacyAdapter();
        const obsolete = adapter.getUiState<{ messageId: number }>(`legacy:menu:${chat}`);
        if (obsolete && obsolete.messageId !== (previous.messageId ?? result.message_id)) {
          await this.deps.telegram
            .call("deleteMessage", {
              chat_id: chat,
              message_id: obsolete.messageId,
            })
            .then(() => adapter.deleteUiState(`legacy:menu:${chat}`))
            .catch(() => undefined);
        }
      }
    } catch (error) {
      if (this.get<PanelState>(key)?.revision !== revision) return;
      if (
        previous.messageId &&
        error instanceof TelegramDeliveryError &&
        error.reason === "message_not_found"
      ) {
        this.set(key, { state: "PENDING", revision });
        await this.panel(chat, thread, payload);
        return;
      }
      this.set(key, {
        ...(this.get<PanelState>(key)?.messageId ? this.get<PanelState>(key) : previous),
        revision,
        state:
          this.get<PanelState>(key)?.messageId ||
          previous.messageId ||
          (error instanceof TelegramDeliveryError && error.category !== "ambiguous")
            ? "PENDING"
            : "RECONCILIATION_REQUIRED",
      });
      throw error;
    }
  }
  async showError(text: string): Promise<void> {
    if (!this.panelScope) throw new Error("panel_scope_required");
    await this.notice(this.panelScope.chat, this.panelScope.thread || undefined, text);
  }
  private canCompactContext(topic: FleetTopic): boolean {
    return (
      !!this.deps.compact &&
      supportsContextCompaction(this.deps.coreVersion) &&
      supportsContextCompaction(this.deps.store.worker(topic.workerId)?.runtimeVersion)
    );
  }
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
    const defaults = record(this.deps.store.global()?.data.defaults);
    const options: UiOptions = {
      ...OUTPUT_DEFAULTS,
      ...(defaults as UiOptions),
      ...(record(defaults.topicDefaults) as UiOptions),
      ...this.get<UiOptions>(
        "topic:" + topic.chatId + ":" + topic.threadId + ":" + topic.generation,
      ),
    };
    return { ...options, compact: options.compact ?? options.compactOutputMode };
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
  ): CallbackButton {
    const id = crypto.randomUUID().replace(/-/g, "");
    this.deps.sql.exec(
      "INSERT INTO ui_callbacks(id,actor,chat,thread,generation,expires,data) VALUES(?,?,?,?,?,?,?)",
      id,
      actor,
      chat,
      thread,
      topic?.generation ?? 0,
      Date.now() + 30 * 60_000,
      JSON.stringify({
        action,
        value,
        ...(this.panelScope ? { panel: true } : {}),
        ...(["pause", "resume", "abort", "stop"].includes(action)
          ? { targetRun: this.deps.store.activeRuns(chat, thread)[0]?.requestId }
          : {}),
      }),
    );
    return { text, callback_data: "ui:" + id };
  }
  private withNavigation(
    actor: number,
    chat: number,
    thread: number,
    topic: FleetTopic | undefined,
    rows: Button[][],
    spec: NavigationSpec,
  ): Button[][] {
    const strip = new Set(spec.strip ?? []);
    const next = rows
      .map((row) =>
        row.filter((button) => {
          if (!strip.has(button.text)) return true;
          if ("callback_data" in button && button.callback_data.startsWith("ui:"))
            this.deps.sql.exec(
              "DELETE FROM ui_callbacks WHERE id=?",
              button.callback_data.slice(3),
            );
          return false;
        }),
      )
      .filter((row) => row.length > 0);
    const navigation: Button[] = [];
    if (spec.back)
      navigation.push(
        this.button(actor, chat, thread, topic, "← Back", spec.back.action, spec.back.value),
      );
    if (spec.home) {
      const link = thread ? this.legacyMain().mainPanelLink(chat) : undefined;
      navigation.push(
        link
          ? { text: "🏠 Home", url: link }
          : this.button(actor, chat, thread, topic, "🏠 Home", "home"),
      );
    }
    if (navigation.length) next.push(navigation);
    return next;
  }

  private async menu(
    chat: number,
    thread: number | undefined,
    text: string,
    rows: Button[][],
  ): Promise<void> {
    await this.panel(chat, thread, {
      text: text.slice(0, 4000),
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: rows },
    });
  }
  private async notice(chat: number, thread: number | undefined, text: string): Promise<void> {
    if (!this.panelScope) {
      await this.deps.telegram.send(chat, thread, text);
      return;
    }
    await this.panel(chat, thread, {
      text: text.slice(0, 4000),
      reply_markup: {
        inline_keyboard: [
          [
            this.button(
              this.panelScope.actor,
              chat,
              thread ?? 0,
              this.deps.store
                .topics()
                .find((t) => t.chatId === chat && t.threadId === thread && t.state === "ACTIVE"),
              "← Settings",
              "settings",
            ),
          ],
        ],
      },
    });
  }
  async rpcDiff(topic: FleetTopic): Promise<unknown> {
    return this.deps.rpc(topic, "session.diff");
  }
  async keyboard(chat: number, topic?: FleetTopic, text = "OpenCode"): Promise<void> {
    if (!this.panelScope) {
      const actor = Number(this.deps.allowedUserId);
      if (!Number.isSafeInteger(actor) || actor < 1) {
        await this.deps.telegram.call("sendMessage", {
          chat_id: chat,
          ...(topic ? { message_thread_id: topic.threadId } : {}),
          text,
          reply_markup: { remove_keyboard: true },
        });
        return;
      }
      return this.forPanel(actor, chat, topic?.threadId ?? 0, topic?.generation ?? 0).keyboard(
        chat,
        topic,
        text,
      );
    }
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
    if (
      this.panelScope &&
      this.panelScope.chat === chat &&
      this.panelScope.thread === (topic?.threadId ?? 0)
    ) {
      const actions: Record<string, string> = {
        [MAIN_BUTTONS.newChat]: "new",
        [MAIN_BUTTONS.history]: "history",
        [MAIN_BUTTONS.mainSettings]: "settings",
        [MAIN_BUTTONS.topicSettings]: "settings",
        [MAIN_BUTTONS.deleteChat]: "delete_topic",
        [MAIN_BUTTONS.pause]: "pause",
        [MAIN_BUTTONS.resume]: "resume",
        [MAIN_BUTTONS.abort]: "abort",
        [MAIN_BUTTONS.compact(true)]: "compact",
        [MAIN_BUTTONS.compact(false)]: "compact",
      };
      await this.menu(
        chat,
        topic?.threadId,
        escape(text),
        keyboard.keyboard
          .filter((row) => row.length)
          .map((row) =>
            row.map((button) =>
              this.button(
                this.panelScope!.actor,
                chat,
                topic?.threadId ?? 0,
                topic,
                typeof button === "string" ? button : button.text,
                actions[typeof button === "string" ? button : button.text] ?? "models",
              ),
            ),
          ),
      );
      return;
    }
    await this.deps.telegram.call("sendMessage", {
      chat_id: chat,
      ...(topic ? { message_thread_id: topic.threadId } : {}),
      text,
      reply_markup: { remove_keyboard: true },
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
  private legacyAdapter(): LegacyUiAdapter {
    return (
      this.deps.legacyUi ??
      new LegacyUiAdapter({
        sql: this.deps.sql,
        store: this.deps.store,
        botVersion: "unknown",
        coreVersion: this.deps.coreVersion,
        rpc: this.deps.rpc,
        commitGlobal: (data, expectedRevision) => this.deps.global(data, expectedRevision),
      })
    );
  }
  private legacyMain(): LegacyMainUi {
    return new LegacyMainUi(this.legacyAdapter());
  }
  private legacyModels(): LegacyModelAdapter {
    return new LegacyModelAdapter(this.legacyAdapter());
  }
  private legacySession(): LegacySessionAdapter {
    return new LegacySessionAdapter(this.legacyAdapter());
  }
  private canonicalRows(
    actor: number,
    chat: number,
    thread: number,
    topic: FleetTopic | undefined,
    keyboard: { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> },
    resolve: (data: string) => [string, string?] | undefined,
  ): Button[][] {
    return keyboard.inline_keyboard
      .map((row) =>
        row.flatMap((button) => {
          const mapped = resolve(button.callback_data ?? "");
          return mapped
            ? [this.button(actor, chat, thread, topic, button.text, mapped[0], mapped[1])]
            : [];
        }),
      )
      .filter((row) => row.length > 0);
  }
  private sessionRows(
    actor: number,
    chat: number,
    thread: number,
    topic: FleetTopic,
    keyboard: { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> },
  ): Button[][] {
    return this.canonicalRows(actor, chat, thread, topic, keyboard, (data) => {
      const fixed = new Map<string, [string, string?]>([
        [SESSION_DASHBOARD_MESSAGES, ["messages"]],
        [SESSION_DASHBOARD_TODOS, ["todos"]],
        [SESSION_DASHBOARD_DIFF, ["diff"]],
        [SESSION_DASHBOARD_CHILDREN, ["children"]],
        [SESSION_DASHBOARD_FILES, ["ls", "."]],
        [SESSION_DASHBOARD_RENAME, ["rename"]],
        [SESSION_DASHBOARD_SETTINGS, ["settings"]],
        ["compact:confirm", ["context_compact"]],
      ]);
      const exact = fixed.get(data);
      if (exact) return exact;
      const messageIndex = parseMessageSelectCallback(data);
      if (messageIndex !== null) return ["message_select", String(messageIndex)];
      const page = parseMessagePageCallback(data);
      if (page !== null) return ["messages_page", String(page)];
      if (data.startsWith(SESSION_DASHBOARD_CHILD_PREFIX))
        return ["child_messages", data.slice(SESSION_DASHBOARD_CHILD_PREFIX.length)];
      if (data.startsWith(LS_CALLBACK_NAV_PREFIX))
        return ["ls", data.slice(LS_CALLBACK_NAV_PREFIX.length)];
      if (data.startsWith(LS_CALLBACK_FILE_PREFIX))
        return ["open", data.slice(LS_CALLBACK_FILE_PREFIX.length)];
      if (data.startsWith(LS_CALLBACK_DOWNLOAD_PREFIX))
        return ["file_download", data.slice(LS_CALLBACK_DOWNLOAD_PREFIX.length)];
      if (data.startsWith(LS_CALLBACK_BACK_PREFIX))
        return ["ls", data.slice(LS_CALLBACK_BACK_PREFIX.length) || "."];
      return undefined;
    });
  }
  private async renderMessages(
    actor: number,
    chat: number,
    thread: number,
    topic: FleetTopic,
    page = 0,
  ): Promise<void> {
    const messages = await this.legacySession().userMessages(topic);
    const pageSize = 8;
    const view = {
      text: messages.length ? formatMessagesSelectText(page) : "🕘 No user messages yet.",
      keyboard: buildMessagesListKeyboard(messages, page, pageSize),
    };
    const rows = this.sessionRows(actor, chat, thread, topic, view.keyboard);
    await this.menu(
      chat,
      thread,
      view.text,
      this.withNavigation(actor, chat, thread, topic, rows, {
        back: { action: "session" },
        home: true,
      }),
    );
  }

  private async renderSessionDashboard(
    actor: number,
    chat: number,
    thread: number,
    topic: FleetTopic,
  ): Promise<void> {
    const session = this.legacySession();
    const info = record(await session.session(topic));
    const [todos, diffs, children] = await Promise.all([
      this.optionalCapability(() => session.todos<unknown[]>(topic)),
      this.optionalCapability(() => session.diff<unknown[]>(topic)),
      this.optionalCapability(() => session.children<unknown[]>(topic)),
    ]);
    this.assertTopic(topic);
    const view = buildSessionDashboardView({
      sessionId: topic.sessionId,
      title: typeof info.title === "string" ? info.title : this.options(topic).title,
      model: this.model(topic),
      busy: this.deps.store.activeRuns(chat, thread).length > 0,
      todos: Array.isArray(todos) ? todos.map((item) => record(item)) : todos,
      diffs: Array.isArray(diffs) ? diffs.map((item) => record(item)) : diffs,
      children: Array.isArray(children) ? children.map((item) => record(item)) : children,
    });
    const rows = this.sessionRows(actor, chat, thread, topic, view.keyboard);
    await this.menu(
      chat,
      thread,
      view.text,
      this.withNavigation(actor, chat, thread, topic, rows, {
        back: { action: "topic_settings" },
        home: true,
        strip: ["← Topic Settings", "🏠 Home"],
      }),
    );
  }
  private async optionalCapability<T>(request: () => Promise<T>): Promise<T | null> {
    try {
      return await request();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("stale_generation") || message.includes("topic_not_writable"))
        throw error;
      return null;
    }
  }
  private modelScope(topic?: FleetTopic): LegacyModelScope {
    return topic ? { kind: "topic", topic } : { kind: "global" };
  }
  private modelButtonRows(
    actor: number,
    chat: number,
    thread: number,
    topic: FleetTopic | undefined,
    keyboard: { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> },
  ): Button[][] {
    const b = (text: string, action: string, value?: string) =>
      this.button(actor, chat, thread, topic, text, action, value);
    return keyboard.inline_keyboard
      .map((row) =>
        row.flatMap((button) => {
          const data = button.callback_data ?? "";
          if (data === MODEL_CENTER_ROOT) return [b(button.text, "models")];
          if (data === MODEL_CENTER_FAVORITES) return [b(button.text, "model_favorites")];
          if (data === MODEL_CENTER_RECENT) return [b(button.text, "model_recent")];
          if (data === MODEL_CENTER_PROVIDERS) return [b(button.text, "model_providers")];
          if (data === MODEL_CENTER_SEARCH || data === MODEL_CENTER_SEARCH_AGAIN)
            return [b(button.text, "model_search")];
          if (data === MODEL_CENTER_SETTINGS_BACK) return [b(button.text, "settings")];
          if (data === "main:home") return [b(button.text, "home")];
          if (data.startsWith(MODEL_CENTER_PROVIDER_PREFIX)) {
            const tail = data.slice(MODEL_CENTER_PROVIDER_PREFIX.length);
            const split = tail.lastIndexOf(":");
            if (split < 1) return [];
            return [
              b(
                button.text,
                "model_provider",
                JSON.stringify({
                  providerID: decodeURIComponent(tail.slice(0, split)),
                  page: Number(tail.slice(split + 1)),
                }),
              ),
            ];
          }
          if (data.startsWith(MODEL_CENTER_SELECT_PREFIX)) {
            const model = resolveModelCenterAction(data.slice(MODEL_CENTER_SELECT_PREFIX.length));
            return model
              ? [b(button.text, "model_save", `${model.providerID}/${model.modelID}`)]
              : [];
          }
          if (data.startsWith(MODEL_CENTER_FAVORITE_PREFIX)) {
            const model = resolveModelCenterAction(data.slice(MODEL_CENTER_FAVORITE_PREFIX.length));
            return model
              ? [b(button.text, "model_favorite_toggle", `${model.providerID}/${model.modelID}`)]
              : [];
          }
          return [];
        }),
      )
      .filter((row) => row.length > 0);
  }
  private topicSettingsState(topic: FleetTopic): CanonicalTopicSettingsState {
    const options = this.options(topic);
    return {
      model: this.model(topic) || "Inherited default",
      agent: options.agent ?? "Inherited default",
      variant: options.variant ?? "Default",
      imageModel: options.imageModel,
      voiceModel: options.voiceModel,
      compactOutputMode: options.compact ?? options.compactOutputMode ?? false,
      showThinkingContent: options.showThinkingContent ?? true,
      responseStreamingMode: options.responseStreamingMode === "draft" ? "draft" : "edit",
      messageFormatMode: options.messageFormatMode === "raw" ? "raw" : "markdown",
      showAssistantRunFooter: options.showAssistantRunFooter ?? true,
      sendDiffFileAttachments: options.sendDiffFileAttachments ?? true,
      promptQueueEnabled: options.promptQueueEnabled ?? true,
    };
  }
  private settingsButtonRows(
    actor: number,
    chat: number,
    thread: number,
    topic: FleetTopic | undefined,
    keyboard: { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> },
  ): Button[][] {
    const b = (text: string, action: string, value?: string) =>
      this.button(actor, chat, thread, topic, text, action, value);
    const exact = new Map<string, [string, string?]>([
      [SETTINGS_DEFAULT_MODELS_CALLBACK, ["models"]],
      [SETTINGS_TOPIC_MODELS_CALLBACK, ["topic_models"]],
      [SETTINGS_MODEL_CALLBACK, ["models"]],
      [SETTINGS_IMAGE_MODEL_CALLBACK, ["model_image"]],
      [SETTINGS_VOICE_MODEL_CALLBACK, ["model_voice"]],
      [SETTINGS_AGENT_CALLBACK, ["agent"]],
      [SETTINGS_VARIANT_CALLBACK, ["variant"]],
      [SETTINGS_APPEARANCE_CALLBACK, ["appearance"]],
      [SETTINGS_NOTIFICATIONS_CALLBACK, ["queue"]],
      [SETTINGS_CONTEXT_CALLBACK, ["context"]],
      [SETTINGS_CLOSE_CALLBACK, ["close"]],
      [SETTINGS_GITHUB_CALLBACK, ["github"]],
      ["integration:tailscale", ["tailscale"]],
      [SETTINGS_EXTENSIONS_CALLBACK, ["extensions"]],
      [SETTINGS_ACTIONS_CALLBACK, ["actions"]],
      [SETTINGS_MORE_CALLBACK, ["more"]],
      [SETTINGS_ADVANCED_CALLBACK, ["advanced"]],
      [SETTINGS_TOPIC_DEFAULTS_CALLBACK, ["topic_defaults"]],
      [SETTINGS_EXPERIMENTAL_CALLBACK, ["experimental"]],
      [SETTINGS_COMMANDS_CALLBACK, ["commands"]],
      [SETTINGS_MEMORY_CALLBACK, ["memory"]],
      [SETTINGS_RESET_HISTORY_CALLBACK, ["reset_history"]],
      [SETTINGS_FACTORY_RESET_CALLBACK, ["factory_reset"]],
      [SETTINGS_BACK_CALLBACK, ["settings"]],
      [SETTINGS_COMPACT_OUTPUT_CALLBACK, ["config_topic_setting", "compactOutputMode"]],
      [SETTINGS_THINKING_CONTENT_CALLBACK, ["config_topic_setting", "showThinkingContent"]],
      [SETTINGS_RESPONSE_STREAMING_CALLBACK, ["config_topic_setting", "responseStreamingMode"]],
      [SETTINGS_MESSAGE_FORMAT_CALLBACK, ["config_topic_setting", "messageFormatMode"]],
      [SETTINGS_ASSISTANT_FOOTER_CALLBACK, ["config_topic_setting", "showAssistantRunFooter"]],
      [SETTINGS_DIFF_FILES_CALLBACK, ["config_topic_setting", "sendDiffFileAttachments"]],
      [SETTINGS_PROMPT_QUEUE_CALLBACK, ["config_topic_setting", "promptQueueEnabled"]],
      [SETTINGS_DEFAULT_COMPACT_CALLBACK, ["config_default", "compactOutputMode"]],
      [SETTINGS_DEFAULT_THINKING_CALLBACK, ["config_default", "showThinkingContent"]],
      [SETTINGS_DEFAULT_STREAMING_CALLBACK, ["config_default", "responseStreamingMode"]],
      [SETTINGS_DEFAULT_FORMAT_CALLBACK, ["config_default", "messageFormatMode"]],
      [SETTINGS_DEFAULT_FOOTER_CALLBACK, ["config_default", "showAssistantRunFooter"]],
      [SETTINGS_DEFAULT_DIFF_CALLBACK, ["config_default", "sendDiffFileAttachments"]],
      [SETTINGS_DEFAULT_QUEUE_CALLBACK, ["config_default", "promptQueueEnabled"]],
      [SETTINGS_FREE_DETECTION_CALLBACK, ["config_free_detection"]],
    ]);
    return keyboard.inline_keyboard
      .map((row) =>
        row.flatMap((button) => {
          const mapped = exact.get(button.callback_data ?? "");
          return mapped ? [b(button.text, mapped[0], mapped[1])] : [];
        }),
      )
      .filter((row) => row.length > 0);
  }
  private async renderModelRoot(
    actor: number,
    chat: number,
    thread: number,
    topic?: FleetTopic,
  ): Promise<void> {
    const models = this.legacyModels();
    const scope = this.modelScope(topic);
    const current = await models.current(topic);
    const view = await buildModelCenterRoot(current, models.source(scope));
    const rows = this.modelButtonRows(actor, chat, thread, topic, view.keyboard);
    await this.menu(
      chat,
      thread || undefined,
      view.text,
      this.withNavigation(actor, chat, thread, topic, rows, {
        back: { action: topic ? "topic_settings" : "settings" },
        home: true,
        strip: ["← Back", "🏠 Home"],
      }),
    );
  }
  private async home(chat: number, actor: number, replace: boolean): Promise<void> {
    if (this.panelScope?.thread) return this.forPanel(actor, chat, 0, 0).home(chat, actor, replace);
    if (replace)
      await this.deps.telegram.call("setMyCommands", {
        commands: BOT_COMMANDS,
        scope: { type: "chat", chat_id: chat },
      });
    const adapter = this.legacyAdapter();
    const previous = adapter.getUiState<{ messageId: number; actorId?: number }>(
      `legacy:main:${chat}`,
    );
    if (this.panelScope && previous && (!previous.actorId || previous.actorId === actor))
      this.adoptPanel(previous.messageId);
    const status = await adapter.getMainStatus();
    const rows = createMainInlineKeyboard({ providerID: "", modelID: "" }).inline_keyboard.map(
      (row) =>
        row.flatMap((button) =>
          "callback_data" in button && button.callback_data?.startsWith("main:")
            ? [this.button(actor, chat, 0, undefined, button.text, button.callback_data.slice(5))]
            : [],
        ),
    );
    await this.menu(chat, undefined, renderLegacyMainStatus(status), rows);
    const identity = this.panelIdentity(actor, chat, 0, 0);
    if (identity.messageId) {
      adapter.setUiState(`legacy:main:${chat}`, { messageId: identity.messageId, actorId: actor });
      if (replace)
        await this.deps.telegram.call("pinChatMessage", {
          chat_id: chat,
          message_id: identity.messageId,
          disable_notification: true,
        });
    }
  }
  private async settings(
    actor: number,
    chat: number,
    thread: number,
    topic?: FleetTopic,
  ): Promise<void> {
    const view = buildCanonicalSettingsMenuView(topic ? this.topicSettingsState(topic) : undefined);
    const rows = this.settingsButtonRows(actor, chat, thread, topic, view.keyboard);
    await this.menu(
      chat,
      topic ? thread : undefined,
      view.text,
      this.withNavigation(actor, chat, thread, topic, rows, {
        home: true,
        strip: ["✖ Close"],
      }),
    );
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
    rows.push([this.button(actor, chat, 0, undefined, MAIN_BUTTONS.newChat, "new")]);
    await this.menu(
      chat,
      undefined,
      "🕘 <b>History</b>\n\n" +
        (topics.length
          ? "Choose a Topic to continue its dedicated session."
          : "No active AI Topics."),
      this.withNavigation(actor, chat, 0, undefined, rows, { home: true }),
    );
  }
  private async confirm(
    actor: number,
    chat: number,
    thread: number,
    topic: FleetTopic | undefined,
    action: string,
    title: string,
    back: NavigationTarget,
  ): Promise<void> {
    await this.menu(
      chat,
      thread || undefined,
      "⚠️ <b>" + escape(title) + "</b>\n\nThis action is destructive and cannot be undone.",
      this.withNavigation(
        actor,
        chat,
        thread,
        topic,
        [[this.button(actor, chat, thread, topic, "🗑️ " + title, action)]],
        { back, home: true },
      ),
    );
  }
  async handle(update: TelegramUpdate, updateId: number): Promise<boolean> {
    const message = update.message ?? update.callback_query?.message;
    const actor = update.message?.from?.id ?? update.callback_query?.from.id;
    if (!message || !actor) return true;
    const thread = (message.message_thread_id ?? 0) > 1 ? message.message_thread_id! : 0;
    const generation =
      this.deps.store.topics().find((t) => t.chatId === message.chat.id && t.threadId === thread)
        ?.generation ?? 0;
    return new CloudBotUi(this.deps, {
      actor,
      chat: message.chat.id,
      thread,
      generation,
    }).handleScoped(update, updateId);
  }
  private async handleScoped(update: TelegramUpdate, updateId: number): Promise<boolean> {
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
    let formAdmitted = false;
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
        if (!row) {
          const current = this.panelIdentity(actor, chat, thread, this.panelScope!.generation);
          if (
            current.messageId &&
            update.callback_query.message?.message_id === current.messageId
          ) {
            this.set("form:" + actor + ":" + chat + ":" + thread, {});
            if (thread) await this.settings(actor, chat, thread, topic);
            else await this.home(chat, actor, false);
          }
          return true;
        }
        if (row.actor !== actor || row.chat !== chat || row.thread !== thread || (thread && !topic))
          return true;
        const candidate = JSON.parse(row.data) as UiAction;
        const safe = navigation.has(candidate.action);
        if (
          safe &&
          row.generation === this.panelScope!.generation &&
          !this.adoptPanel(update.callback_query.message?.message_id)
        )
          return true;
        const panel =
          this.get<PanelState>(`panel:${actor}:${chat}:${thread}:${topic?.generation ?? 0}`) ?? {};
        const stale =
          row.expires < Date.now() ||
          row.state !== "READY" ||
          row.generation !== (topic?.generation ?? 0) ||
          (candidate.panel &&
            (update.callback_query.message?.message_id !== panel.messageId ||
              !panel.callbacks?.includes(data.slice(3))));
        if (stale && !safe) {
          await this.notice(
            chat,
            thread || undefined,
            "This action has expired. Open its menu again.",
          );
          return true;
        }
        action =
          stale && row.generation !== (topic?.generation ?? 0)
            ? { action: thread ? "settings" : "home" }
            : candidate;
        if (!safe)
          this.deps.sql.exec(
            "UPDATE ui_callbacks SET state='CLAIMED' WHERE id=? AND state='READY'",
            data.slice(3),
          );
      } else if (
        ["main:new", "main:home", "main:history", "main:settings"].includes(data) &&
        !thread
      ) {
        if (!this.adoptPanel(update.callback_query.message?.message_id)) return true;
        action = { action: data === "main:new" ? "home" : data.slice(5) };
      } else {
        await this.settings(actor, chat, thread, topic);
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
          action.action === "context_compact" ||
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
      const form = this.get<{
        kind: string;
        generation: number;
        expires: number;
        returnAction?: string;
        returnValue?: string;
      }>(formKey);
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
        formAdmitted = true;
        this.set(actionKey, { actor, chat, thread, generation: topic?.generation ?? 0, action });
        this.set(formKey, {});
      } else if (!text || !thread) {
        if (update.message?.message_id) {
          try {
            await this.deps.telegram.call("deleteMessage", {
              chat_id: chat,
              message_id: update.message.message_id,
            });
          } catch {
            /* Unrequested input must never reach execution. */
          }
        }
        return true;
      } else return false;
    }
    if (!saved) {
      if (!action.targetRun && ["pause", "resume", "abort", "stop"].includes(action.action))
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
    if (!formAdmitted && !protectedInput) this.set("form:" + actor + ":" + chat + ":" + thread, {});
    const mainOnly = [
      "new",
      "new_chat",
      "history",
      "sessions",
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
      "messages_page",
      "message_select",
      "context",
      "context_compact",
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
      if (update.message?.message_id) {
        await this.deps.telegram
          .call("deleteMessage", { chat_id: chat, message_id: update.message.message_id })
          .catch(() => undefined);
      }
      await this.deps.saveCredential(
        update as ProtectedTelegramUpdate,
        protectedInput.providerId,
        topic?.generation ?? 0,
      );
      this.set("form:" + actor + ":" + chat + ":" + thread, {});
      this.set("action_done:" + updateId, true);
      await this.notice(
        chat,
        thread || undefined,
        protectedInput.providerId.startsWith("integration.")
          ? "✅ Account verified. Credential stored securely. Worker Git/VPN connection is not yet enabled."
          : "✅ Provider credential stored securely.",
      );
      return true;
    }
    if (name === "start") {
      if (topic) await this.keyboard(chat, topic, "OpenCode Core " + this.deps.coreVersion);
      else {
        const resetKey = `start:${actor}:${chat}:${updateId}`;
        if (!this.get(resetKey)) {
          const key = `panel:${actor}:${chat}:0:0`;
          const old =
            this.get<PanelState>(key) ??
            this.legacyAdapter().getUiState<PanelState>(`legacy:main:${chat}`);
          if (old?.messageId) {
            try {
              await this.deps.telegram.call("editMessageReplyMarkup", {
                chat_id: chat,
                message_id: old.messageId,
                reply_markup: { inline_keyboard: [] },
              });
            } catch (error) {
              if (
                !(error instanceof TelegramDeliveryError) ||
                !["message_not_found", "message_not_editable"].includes(error.reason ?? "")
              )
                throw error;
            }
            await this.deps.telegram
              .call("unpinChatMessage", { chat_id: chat, message_id: old.messageId })
              .catch(() => undefined);
          }
          this.deps.sql.exec(
            "DELETE FROM ui_callbacks WHERE actor=? AND chat=? AND thread=0",
            actor,
            chat,
          );
          this.legacyAdapter().deleteUiState(`legacy:main:${chat}`);
          const cleared =
            this.get<{ state: string }>(`keyboard-cleared:${actor}:${chat}`)?.state === "CLEARED";
          if (!old?.messageId) this.set(`keyboard-cleared:${actor}:${chat}`, { state: "CLEARED" });
          this.set(key, {
            state: "PENDING",
            clearKeyboard: !!old?.messageId && !cleared,
            revision: old?.revision ?? 0,
          });
          this.set(resetKey, { retired: true });
        }
        await this.home(chat, actor, true);
      }
      return true;
    }
    if (name === "home") {
      await this.home(chat, actor, false);
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
      if (!pending) await this.deps.newTopic(chat, "telegram_" + updateId);
      this.set("action_done:" + updateId, true);
      await this.notice(chat, thread || undefined, t("bot.creating_session", undefined, "en"));
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
      const formKey = "form:" + actor + ":" + chat + ":" + thread;
      const taskKey = taskDraftKey(actor, chat, thread, topic?.generation ?? 0);
      const configKey = `config-draft:${actor}:${chat}:${thread}:${topic?.generation ?? 0}`;
      const activeForm = this.get<{ returnAction?: string; returnValue?: string }>(formKey);
      const taskDraft = this.get<Record<string, unknown>>(taskKey);
      const configDraft = this.get<Record<string, unknown>>(configKey);
      let returnAction = activeForm?.returnAction;
      const returnValue = activeForm?.returnValue;
      if (!returnAction && configDraft) {
        const section = String(configDraft.section ?? "");
        if (["skills", "commands", "mcps"].includes(section)) returnAction = section;
      }
      if (!returnAction && taskDraft && Object.keys(taskDraft).length) returnAction = "tasklist";
      this.set(formKey, {});
      this.deps.sql.exec("DELETE FROM ui_state WHERE key=?", taskKey);
      this.deps.sql.exec("DELETE FROM ui_state WHERE key=?", configKey);
      this.set("action_done:" + updateId, true);
      if (returnAction) {
        if (returnAction === "settings") await this.settings(actor, chat, thread, topic);
        else if (returnAction === "topic_settings") await this.settings(actor, chat, thread, topic);
        else if (returnAction === "session") {
          if (!topic) throw new Error("topic_not_writable");
          await this.renderSessionDashboard(actor, chat, thread, topic);
        } else if (returnAction === "question_return") {
          if (!topic || !returnValue) throw new Error("topic_not_writable");
          const key = "question:" + topic.workerId + ":" + topic.generation + ":" + returnValue;
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
          this.deps.sql.exec(
            "DELETE FROM ui_state WHERE key=?",
            "custom_question:" + actor + ":" + chat + ":" + thread,
          );
          await this.questionMenu(topic, actor, returnValue, pending.questions, pending.answers);
        } else {
          const rendered = await this.handleAction(
            actor,
            chat,
            thread,
            topic,
            { action: returnAction, value: returnValue },
            undefined,
          );
          if (!rendered) throw new Error("invalid_navigation_target");
        }
        return true;
      }
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
      await this.forPanel(actor, chat, target.threadId, target.generation).keyboard(
        chat,
        target,
        "Continue this session here.",
      );
      return true;
    }
    if (["delete", "delete_topic"].includes(name)) {
      await this.confirm(actor, chat, thread, topic, "delete_confirm", "Delete Chat", {
        action: "topic_settings",
      });
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
    if (name === "context_compact") {
      if (!this.canCompactContext(topic!)) {
        await this.notice(chat, thread, t("context.error"));
        return true;
      }
      await this.deps.compact!(topic!, "telegram_compact_" + updateId);
      this.assertTopic(topic!);
      this.set("action_done:" + updateId, true);
      await this.notice(chat, thread, t("context.progress"));
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
        returnAction: "session",
      });
      await this.menu(chat, thread, "Send the new Topic name, or /cancel.", [
        [this.button(actor, chat, thread, topic, "✖ Cancel", "cancel")],
      ]);
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
      this.setOptions(topic!, { title, titleSource: "manual" });
      this.set("action_done:" + updateId, true);
      await this.notice(chat, thread, "✅ Topic renamed.");
      return true;
    }
    if (name === "status" && !topic) {
      await this.notice(
        chat,
        undefined,
        "Cloudflare Control Plane is healthy.\nAI Topics: " +
          this.deps.store.topics().filter((t) => t.chatId === chat && t.state === "ACTIVE").length +
          "\nCore " +
          this.deps.coreVersion,
      );
      return true;
    }
    if (topic && (name === "status" || name === "session")) {
      await this.renderSessionDashboard(actor, chat, thread, topic);
      return true;
    }
    if (topic && name === "context") {
      const info = record(await this.legacySession().session(topic));
      const title = String(info.title ?? this.options(topic).title ?? topic.sessionId);
      const view = buildCanonicalContextControlView(title, this.canCompactContext(topic));
      const rows = this.sessionRows(actor, chat, thread, topic, view.keyboard);
      await this.menu(
        chat,
        thread,
        view.text,
        this.withNavigation(actor, chat, thread, topic, rows, {
          back: { action: "topic_settings" },
          home: true,
          strip: ["← Back", "🏠 Home"],
        }),
      );
      return true;
    }
    if (topic && name === "messages") {
      await this.renderMessages(actor, chat, thread, topic, 0);
      return true;
    }
    if (topic && name === "messages_page") {
      const page = Number(action.value);
      if (!Number.isInteger(page) || page < 0) throw new Error("invalid_messages_page");
      await this.renderMessages(actor, chat, thread, topic, page);
      return true;
    }
    if (topic && name === "message_select") {
      const index = Number(action.value);
      if (!Number.isInteger(index) || index < 0) throw new Error("invalid_message_index");
      const messages = await this.legacySession().userMessages(topic);
      const message = messages[index];
      if (!message) throw new Error("interaction_expired");
      const keyboard = buildMessageReadOnlyDetailKeyboard();
      const rows = this.sessionRows(actor, chat, thread, topic, keyboard);
      await this.menu(
        chat,
        thread,
        escape(formatMessageDetailText(message)),
        this.withNavigation(actor, chat, thread, topic, rows, {
          back: { action: "messages" },
          home: true,
          strip: ["← Back", "🏠 Home"],
        }),
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
      this.setOptions(topic, { title, titleSource: "manual" });
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
    const configDraftKey = `config-draft:${actor}:${chat}:${thread}:${topic?.generation ?? 0}`;
    const configNavigation = (): NavigationSpec | undefined => {
      if (name.startsWith("config_wizard_")) return undefined;
      if (name === "memory" || name.startsWith("config_memory_"))
        return {
          back: { action: "advanced" },
          home: true,
          strip: ["← Settings", "← Back", "🏠 Home"],
        };
      const direct = /^(providers|extensions|actions|skills|mcps|plugins|commands)$/.exec(
        name,
      )?.[1];
      const item =
        /^config_(?:item|toggle|remove|add)_(providers|extensions|actions|skills|mcps|plugins|commands)$/.exec(
          name,
        )?.[1];
      const section = direct ?? item;
      if (!section) return undefined;
      const parent =
        section === "commands"
          ? "advanced"
          : ["skills", "mcps", "plugins"].includes(section)
            ? "extensions"
            : "settings";
      if (name.startsWith("config_item_"))
        return {
          back: { action: section },
          home: true,
          strip: ["← Settings", "← Back", "← " + section, "🏠 Home"],
        };
      return { back: { action: parent }, home: true, strip: ["← Settings", "← Back", "🏠 Home"] };
    };
    const configWizardOrigin = (): NavigationTarget | undefined => {
      const row = [
        ...this.deps.sql.exec<{ data: string }>(
          "SELECT data FROM ui_state WHERE key=?",
          configDraftKey,
        ),
      ][0];
      if (row) {
        const section = String(record(JSON.parse(row.data)).section ?? "");
        if (["skills", "commands", "mcps"].includes(section)) return { action: section };
      }
      const jsonSection =
        /^config_json_(providers|extensions|actions|skills|mcps|plugins|commands)$/.exec(name)?.[1];
      if (jsonSection) return { action: jsonSection };
      if (
        ["config_memory_add", "config_memory_forget", "config_remember", "config_forget"].includes(
          name,
        )
      )
        return { action: "memory" };
      return undefined;
    };
    const configUi = new CloudConfigUi({
      draftKey: configDraftKey,
      markCommitted: () => {
        if (updateId) this.set("action_done:" + updateId, true);
      },
      sql: this.deps.sql,
      store: this.deps.store,
      telegram: this.deps.telegram,
      commit: async (data, revision) => {
        await this.deps.global(data, revision);
        if (updateId) this.set("action_done:" + updateId, true);
      },
      button: b,
      notice: (text) => this.notice(chat, thread || undefined, text),
      menu: (text, rows) => {
        const navigation = configNavigation();
        return this.menu(
          chat,
          thread || undefined,
          text,
          navigation ? this.withNavigation(actor, chat, thread, topic, rows, navigation) : rows,
        );
      },
      prompt: async (kind, text) => {
        const origin = configWizardOrigin();
        this.set("form:" + actor + ":" + chat + ":" + thread, {
          kind,
          generation: topic?.generation ?? 0,
          expires: Date.now() + 300000,
          ...(origin ? { returnAction: origin.action, returnValue: origin.value } : {}),
        });
        await this.menu(chat, thread || undefined, text, [
          [this.button(actor, chat, thread, topic, "✖ Cancel", "cancel")],
        ]);
      },
    });
    const prompt = async (kind: string, text: string) => {
      const origin: NavigationTarget | undefined = kind.startsWith("config_task_")
        ? { action: "tasklist" }
        : kind === "open"
          ? { action: "ls", value: "." }
          : kind === "config_image_model" || kind === "config_voice_model"
            ? { action: topic ? "topic_models" : "models" }
            : undefined;
      this.set("form:" + actor + ":" + chat + ":" + thread, {
        kind,
        generation: topic?.generation ?? 0,
        expires: Date.now() + 300000,
        ...(origin ? { returnAction: origin.action, returnValue: origin.value } : {}),
      });
      await this.menu(chat, thread || undefined, text, [
        [this.button(actor, chat, thread, topic, "✖ Cancel", "cancel")],
      ]);
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
      menu: (text, rows) =>
        this.menu(
          chat,
          thread || undefined,
          text,
          name === "tasklist"
            ? this.withNavigation(actor, chat, thread, topic, rows, {
                ...(topic ? { back: { action: "session" } } : {}),
                home: true,
              })
            : rows,
        ),
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
        returnAction: "config_item_providers",
        returnValue: providerId,
      });
      await this.menu(
        chat,
        thread || undefined,
        "Send the provider API key. It will be encrypted before durable storage and never sent to a model. Use /cancel to cancel.",
        [[this.button(actor, chat, thread, topic, "✖ Cancel", "cancel")]],
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
      let changedField: (typeof fields)[number] | undefined;
      if (name === "config_topic_setting") {
        if (!fields.includes(action.value as (typeof fields)[number]))
          throw new Error("invalid_setting");
        const field = action.value as (typeof fields)[number];
        changedField = field;
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
      const state = this.topicSettingsState(topic);
      const view =
        name === "queue" || changedField === "promptQueueEnabled"
          ? buildCanonicalPromptQueueSettingsView(state.promptQueueEnabled)
          : buildCanonicalAppearanceSettingsView(state);
      const rows = this.settingsButtonRows(actor, chat, thread, topic, view.keyboard);
      await this.menu(
        chat,
        thread,
        view.text,
        this.withNavigation(actor, chat, thread, topic, rows, {
          back: { action: "topic_settings" },
          home: true,
          strip: ["← Back", "🏠 Home"],
        }),
      );
      return true;
    }
    if (name === "config_item_providers") {
      const runtime = record(record(global?.data.configuration).runtime),
        providers = record(runtime.provider);
      if (!action.value || !Object.hasOwn(providers, action.value))
        throw new Error("provider_not_configured");
      const rows: Button[][] = [
        [b("🔐 Connect / Replace credential", "config_credential_provider", action.value)],
        [b("Toggle Enabled", "config_toggle_providers", action.value)],
        [b("Edit", "config_add_providers")],
        [b("Remove", "config_remove_providers", action.value)],
      ];
      await this.menu(
        chat,
        thread || undefined,
        "🔌 <b>" + escape(action.value) + "</b>",
        this.withNavigation(actor, chat, thread, topic, rows, {
          back: { action: "providers" },
          home: true,
        }),
      );
      return true;
    }
    if (name === "topic_models") {
      if (!topic) throw new Error("topic_not_writable");
      const view = buildCanonicalTopicModelsSettingsView(this.topicSettingsState(topic));
      const rows = this.settingsButtonRows(actor, chat, thread, topic, view.keyboard);
      await this.menu(
        chat,
        thread,
        view.text,
        this.withNavigation(actor, chat, thread, topic, rows, {
          back: { action: "topic_settings" },
          home: true,
          strip: ["← Topic Settings", "🏠 Home"],
        }),
      );
      return true;
    }
    if (name === "more" || name === "advanced") {
      const view =
        name === "more" ? buildCanonicalMoreSettingsView() : buildCanonicalAdvancedSettingsView();
      const rows = this.settingsButtonRows(actor, chat, thread, topic, view.keyboard);
      await this.menu(
        chat,
        thread || undefined,
        view.text,
        this.withNavigation(actor, chat, thread, topic, rows, {
          back: { action: name === "more" ? "settings" : "more" },
          home: true,
          strip: ["← Settings", "← Back", "🏠 Home"],
        }),
      );
      return true;
    }
    if (name === "topic_defaults" || name === "config_default") {
      if (!global) throw new Error("snapshot_unavailable");
      if (name === "config_default") {
        const field = action.value ?? "";
        if (!Object.hasOwn(OUTPUT_DEFAULTS, field)) throw new Error("invalid_default");
        const data = structuredClone(global.data);
        const defaults = record(data.defaults);
        const topicDefaults = record(defaults.topicDefaults);
        data.defaults = defaults;
        defaults.topicDefaults = topicDefaults;
        const previous =
          topicDefaults[field] ?? OUTPUT_DEFAULTS[field as keyof typeof OUTPUT_DEFAULTS];
        topicDefaults[field] =
          typeof previous === "boolean"
            ? !previous
            : field === "responseStreamingMode"
              ? previous === "off"
                ? "edit"
                : "off"
              : previous === "raw"
                ? "markdown"
                : "raw";
        await this.deps.global(data, global.revision);
        if (updateId) this.set("action_done:" + updateId, true);
      }
      const fresh = this.deps.store.global();
      const values = record(record(fresh?.data.defaults).topicDefaults);
      const view = buildCanonicalTopicDefaultsSettingsView({
        compactOutputMode: Boolean(values.compactOutputMode ?? OUTPUT_DEFAULTS.compactOutputMode),
        showThinkingContent: Boolean(
          values.showThinkingContent ?? OUTPUT_DEFAULTS.showThinkingContent,
        ),
        responseStreamingMode: values.responseStreamingMode === "draft" ? "draft" : "edit",
        messageFormatMode: values.messageFormatMode === "raw" ? "raw" : "markdown",
        showAssistantRunFooter: Boolean(
          values.showAssistantRunFooter ?? OUTPUT_DEFAULTS.showAssistantRunFooter,
        ),
        sendDiffFileAttachments: Boolean(
          values.sendDiffFileAttachments ?? OUTPUT_DEFAULTS.sendDiffFileAttachments,
        ),
        promptQueueEnabled: Boolean(
          values.promptQueueEnabled ?? OUTPUT_DEFAULTS.promptQueueEnabled,
        ),
      });
      const rows = this.settingsButtonRows(actor, chat, thread, topic, view.keyboard);
      await this.menu(
        chat,
        thread || undefined,
        view.text,
        this.withNavigation(actor, chat, thread, topic, rows, {
          back: { action: "more" },
          home: true,
          strip: ["← Back", "← Settings", "🏠 Home"],
        }),
      );
      return true;
    }
    if (name === "experimental" || name === "config_free_detection") {
      if (!global) throw new Error("snapshot_unavailable");
      if (name === "config_free_detection") {
        const data = structuredClone(global.data);
        const configuration = record(data.configuration);
        const settings = record(configuration.settings);
        data.configuration = configuration;
        configuration.settings = settings;
        settings.experimentalFreeModelDetection = settings.experimentalFreeModelDetection !== true;
        await this.deps.global(data, global.revision);
        if (updateId) this.set("action_done:" + updateId, true);
      }
      const fresh = this.deps.store.global();
      const enabled =
        record(record(fresh?.data.configuration).settings).experimentalFreeModelDetection === true;
      const view = buildCanonicalExperimentalSettingsView(enabled);
      const rows = this.settingsButtonRows(actor, chat, thread, topic, view.keyboard);
      await this.menu(
        chat,
        thread || undefined,
        view.text,
        this.withNavigation(actor, chat, thread, topic, rows, {
          back: { action: "more" },
          home: true,
          strip: ["← Back", "← Settings", "🏠 Home"],
        }),
      );
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
          returnAction: "question_return",
          returnValue: id,
        });
        this.set("custom_question:" + actor + ":" + chat + ":" + thread, { id, index });
        await this.menu(chat, thread, "Send your answer, or /cancel.", [
          [this.button(actor, chat, thread, topic, "✖ Cancel", "cancel")],
        ]);
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
      const file = await this.legacySession().download(topic, action.value);
      await this.deps.telegram.document(chat, thread, file.filename, file.content);
      return true;
    }
    if (["todos", "diff", "children", "child_messages", "ls", "open"].includes(name)) {
      if (!topic) throw new Error("topic_not_writable");
      const session = this.legacySession();
      if (name === "open" && !action.value) {
        await prompt("open", "Send a relative workspace file path, or /cancel.");
        return true;
      }
      if (name === "ls") {
        const path = action.value?.trim() || ".";
        const result = await session.list<unknown>(topic, path);
        const entries = Array.isArray(result) ? result.map((item) => record(item)) : [];
        const view = buildRemoteLsBrowseView(
          entries.map((entry) => ({
            type: entry.type === "directory" ? "directory" : "file",
            name: typeof entry.name === "string" ? entry.name : undefined,
            path: typeof entry.path === "string" ? entry.path : undefined,
            size: typeof entry.size === "number" ? entry.size : undefined,
          })),
          path,
        );
        const rows = this.sessionRows(actor, chat, thread, topic, view.keyboard);
        const navigation =
          path === "."
            ? this.withNavigation(actor, chat, thread, topic, rows, {
                back: { action: "session" },
                home: true,
              })
            : this.withNavigation(actor, chat, thread, topic, rows, {
                back: { action: "ls", value: parentWorkspacePath(path) },
                home: true,
              });
        await this.menu(chat, thread, view.text, navigation);
        return true;
      }
      if (name === "open") {
        const path = action.value!.trim();
        const file = record(await session.read(topic, path));
        const size =
          typeof file.size === "number"
            ? file.size
            : typeof file.content === "string"
              ? file.content.length
              : undefined;
        const view = buildRemoteLsFileView(path, size, true);
        const rows = this.sessionRows(actor, chat, thread, topic, view.keyboard);
        await this.menu(
          chat,
          thread,
          view.text,
          this.withNavigation(actor, chat, thread, topic, rows, { home: true }),
        );
        return true;
      }
      if (name === "todos") {
        const result = await this.optionalCapability(() => session.todos<unknown[]>(topic));
        const view = buildSessionTodosView(
          Array.isArray(result) ? result.map((item) => record(item)) : result,
        );
        const rows = this.sessionRows(actor, chat, thread, topic, view.keyboard);
        await this.menu(
          chat,
          thread,
          view.text,
          this.withNavigation(actor, chat, thread, topic, rows, {
            back: { action: "session" },
            home: true,
          }),
        );
        return true;
      }
      if (name === "diff") {
        const result = await this.optionalCapability(() => session.diff<unknown[]>(topic));
        const view = buildSessionDiffView(
          Array.isArray(result) ? result.map((item) => record(item)) : result,
        );
        const rows = this.sessionRows(actor, chat, thread, topic, view.keyboard);
        await this.menu(
          chat,
          thread,
          view.text,
          this.withNavigation(actor, chat, thread, topic, rows, {
            back: { action: "session" },
            home: true,
          }),
        );
        return true;
      }
      if (name === "children") {
        const result = await this.optionalCapability(() => session.children<unknown[]>(topic));
        const view = buildSessionChildrenView(
          Array.isArray(result) ? result.map((item) => record(item)) : result,
        );
        const rows = this.sessionRows(actor, chat, thread, topic, view.keyboard);
        await this.menu(
          chat,
          thread,
          view.text,
          this.withNavigation(actor, chat, thread, topic, rows, {
            back: { action: "session" },
            home: true,
          }),
        );
        return true;
      }
      const entries = await session.childMessages<unknown[]>(topic, action.value ?? "");
      const text = (Array.isArray(entries) ? entries : [])
        .slice(-10)
        .map((item) => {
          const parts = record(item).parts;
          return Array.isArray(parts)
            ? parts
                .filter((part) => record(part).type === "text")
                .map((part) => String(record(part).text ?? ""))
                .join("\n")
            : "";
        })
        .filter(Boolean)
        .join("\n\n");
      await this.menu(
        chat,
        thread,
        "🤖 <b>Sub-agent messages</b>\n\n" + escape(text || "No child messages yet."),
        this.withNavigation(actor, chat, thread, topic, [], {
          back: { action: "children" },
          home: true,
        }),
      );
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
    if (name === "integration_connect") {
      const id = action.value;
      if (id !== "github" && id !== "tailscale") throw new Error("invalid_integration");
      this.set(`form:${actor}:${chat}:${thread}`, {
        kind: "credential",
        providerId: "integration." + id,
        generation: topic?.generation ?? 0,
        expires: Date.now() + 300000,
      });
      await this.menu(
        chat,
        thread || undefined,
        id === "github"
          ? "Send a scoped GitHub personal access token. It will be validated with GitHub and encrypted before storage. Use /cancel to cancel."
          : "Send a Tailscale API access token (tskey-api-…). This connects the account API; it does not enroll the execution Worker in your tailnet. Use /cancel to cancel.",
        [[this.button(actor, chat, thread, topic, "✖ Cancel", "cancel")]],
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
          (status.accountConnected
            ? "Account connected" + (status.username ? " · " + escape(String(status.username)) : "")
            : "Not connected") +
          "\n" +
          (name === "github"
            ? "Repository access belongs to the dedicated Core Worker. A scoped GitHub credential and governed Git transport must be configured before connecting."
            : "VPN, SSH and tailscaled run only on execution Workers. A scoped Tailscale credential and governed runtime connection are required."),
        this.withNavigation(
          actor,
          chat,
          thread,
          topic,
          [
            [
              this.button(
                actor,
                chat,
                thread,
                topic,
                status.accountConnected ? "🔑 Reconnect account" : "🔗 Connect account",
                "integration_connect",
                name,
              ),
            ],
            [
              {
                text: name === "github" ? "Create GitHub token" : "Create Tailscale API token",
                url:
                  name === "github"
                    ? "https://github.com/settings/personal-access-tokens"
                    : "https://login.tailscale.com/admin/settings/keys",
              },
            ],
          ],
          { back: { action: "settings" }, home: true },
        ),
      );
      return true;
    }
    if (name === "models" || name === "model") {
      const models = this.legacyModels();
      const scope = this.modelScope(topic);
      if (topic) await models.providers(scope);
      await this.renderModelRoot(actor, chat, thread, topic);
      return true;
    }
    if (name === "model_favorites" || name === "model_recent") {
      const models = this.legacyModels();
      const scope = this.modelScope(topic);
      const current = await models.current(topic);
      const view = await buildModelCenterList(
        name === "model_favorites" ? "favorites" : "recent",
        current,
        models.source(scope),
      );
      const rows = this.modelButtonRows(actor, chat, thread, topic, view.keyboard);
      await this.menu(
        chat,
        thread || undefined,
        view.text,
        this.withNavigation(actor, chat, thread, topic, rows, {
          back: { action: "models" },
          home: true,
          strip: ["← Model Center", "🏠 Home"],
        }),
      );
      return true;
    }
    if (name === "model_providers") {
      const models = this.legacyModels();
      const scope = this.modelScope(topic);
      const view = await buildModelCenterProviders(models.source(scope));
      const rows = this.modelButtonRows(actor, chat, thread, topic, view.keyboard);
      await this.menu(
        chat,
        thread || undefined,
        view.text,
        this.withNavigation(actor, chat, thread, topic, rows, {
          back: { action: "models" },
          home: true,
          strip: ["← Model Center", "🏠 Home"],
        }),
      );
      return true;
    }
    if (name === "model_provider") {
      const input = JSON.parse(action.value ?? "{}") as { providerID?: string; page?: number };
      if (!input.providerID || !Number.isSafeInteger(input.page ?? -1))
        throw new Error("invalid_model_provider");
      const models = this.legacyModels();
      const scope = this.modelScope(topic);
      const provider = (await models.providers(scope)).find((item) => item.id === input.providerID);
      if (!provider) throw new Error("model_provider_unavailable");
      const current = await models.current(topic);
      const view = await buildModelCenterProvider(
        provider,
        input.page!,
        current,
        undefined,
        models.source(scope),
      );
      const rows = this.modelButtonRows(actor, chat, thread, topic, view.keyboard);
      await this.menu(
        chat,
        thread || undefined,
        view.text,
        this.withNavigation(actor, chat, thread, topic, rows, {
          back: { action: "model_providers" },
          home: true,
          strip: ["← Providers", "← Model Center", "🏠 Home"],
        }),
      );
      return true;
    }
    if (name === "model_search") {
      this.set("form:" + actor + ":" + chat + ":" + thread, {
        kind: "model_search",
        generation: topic?.generation ?? 0,
        expires: Date.now() + 300000,
        returnAction: "models",
      });
      await this.menu(
        chat,
        thread || undefined,
        "🔎 Send a model name, ID, or provider to search, or /cancel.",
        [[this.button(actor, chat, thread, topic, "✖ Cancel", "cancel")]],
      );
      return true;
    }
    if (name === "model_search_save") {
      const query = (action.value ?? "").trim();
      if (!query || query.length > 128) throw new Error("invalid_model_search");
      const models = this.legacyModels();
      const scope = this.modelScope(topic);
      const current = await models.current(topic);
      const view = await buildModelCenterSearchResults(query, current, models.source(scope));
      const rows = this.modelButtonRows(actor, chat, thread, topic, view.keyboard);
      await this.menu(
        chat,
        thread || undefined,
        view.text,
        this.withNavigation(actor, chat, thread, topic, rows, {
          back: { action: "models" },
          home: true,
          strip: ["← Back", "← Model Center", "🏠 Home"],
        }),
      );
      return true;
    }
    if (name === "model_favorite_toggle") {
      const selected = action.value?.trim() ?? "";
      const split = selected.indexOf("/");
      if (split < 1) throw new Error("invalid_model");
      const models = this.legacyModels();
      await models.toggleFavorite(this.modelScope(topic), {
        providerID: selected.slice(0, split),
        modelID: selected.slice(split + 1),
      });
      if (updateId) this.set("action_done:" + updateId, true);
      await this.renderModelRoot(actor, chat, thread, topic);
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
      const rows: Button[][] = names.slice(0, 40).map((value) => [b(value, name + "_save", value)]);
      await this.menu(
        chat,
        thread,
        (name === "agent" ? "🤖 <b>Agent</b>" : "🎛 <b>Variant</b>") +
          (names.length ? "" : "\nNo choices advertised by this runtime/model."),
        this.withNavigation(actor, chat, thread, topic, rows, {
          back: { action: "topic_settings" },
          home: true,
        }),
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
      const returnAction = name === "model_edit" ? "models" : "topic_settings";
      this.set("form:" + actor + ":" + chat + ":" + thread, {
        kind: name === "model_edit" ? "model" : name,
        generation: topic?.generation ?? 0,
        expires: Date.now() + 300000,
        returnAction,
      });
      await this.menu(
        chat,
        thread || undefined,
        name === "model_edit"
          ? "Send the exact provider/model ID, or /cancel."
          : "Send the " + name + " name, or /cancel.",
        [[this.button(actor, chat, thread, topic, "✖ Cancel", "cancel")]],
      );
      return true;
    }
    if (name === "model_save") {
      const selected = action.value?.trim() ?? "";
      const split = selected.indexOf("/");
      if (split < 1 || split === selected.length - 1) throw new Error("invalid_model");
      if (topic && this.deps.store.activeRuns(chat, thread).length)
        throw new Error("execution_active");
      const models = this.legacyModels();
      await models.select(this.modelScope(topic), {
        providerID: selected.slice(0, split),
        modelID: selected.slice(split + 1),
      });
      if (updateId) this.set("action_done:" + updateId, true);
      await this.renderModelRoot(actor, chat, thread, topic);
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
      await this.confirm(actor, chat, thread, topic, "factory_reset_final", "Final Factory Reset", {
        action: "factory_reset",
      });
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
        { action: "advanced" },
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
