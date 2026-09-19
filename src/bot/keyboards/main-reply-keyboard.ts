import { InlineKeyboard, Keyboard } from "grammy";
import { getAgentButtonLabel } from "../../app/types/agent.js";
import type { ModelInfo } from "../../app/types/model.js";
import type { ContextInfo } from "./keyboard-types.js";

export const MAIN_BUTTONS = {
  history: "🕘 History",
  newChat: "💬 New Chat",
  mainSettings: "⚙️ Main Settings",
  topicSettings: "⚙️ Topic Settings",
  settings: "⚙️ Main Settings",
  deleteChat: "🗑️ Delete Chat",
  compact: (enabled: boolean) => `📦 Compact: ${enabled ? "ON" : "OFF"}`,
  pause: "⏸️ Pause",
  resume: "▶️ Resume",
  abort: "🛑 Abort",
} as const;

export const TOPIC_BUTTONS = {
  abort: MAIN_BUTTONS.abort,
  pause: MAIN_BUTTONS.pause,
  resume: MAIN_BUTTONS.resume,
  compact: (enabled: boolean) => MAIN_BUTTONS.compact(enabled),
  models: "🧠 Models",
  modelCenter: (_model?: ModelInfo) => "🧠 Models",
  deleteChat: MAIN_BUTTONS.deleteChat,
  topicSettings: MAIN_BUTTONS.topicSettings,
} as const;

export interface MainKeyboardOptions {
  queuedPromptLabels?: string[];
  paused?: boolean;
  running?: boolean;
  compactOutputMode?: boolean;
  currentModel?: ModelInfo;
  isTopic?: boolean;
}

function addQueuedPromptButtons(keyboard: Keyboard, labels: string[]): void {
  for (const label of labels) keyboard.text(label).row();
}

function addMainControls(keyboard: Keyboard): void {
  keyboard.text(MAIN_BUTTONS.newChat).row();
  keyboard.text(MAIN_BUTTONS.history).text(MAIN_BUTTONS.mainSettings).row();
}

function addTopicControls(keyboard: Keyboard, paused: boolean, running: boolean, compactOutputMode: boolean, currentModel?: ModelInfo): void {
  if (running || paused) {
    keyboard.text(paused ? MAIN_BUTTONS.resume : MAIN_BUTTONS.pause).text(MAIN_BUTTONS.abort).row();
  }
  keyboard.text(MAIN_BUTTONS.compact(compactOutputMode)).row();
  keyboard.text(TOPIC_BUTTONS.modelCenter(currentModel)).row();
  keyboard.text(MAIN_BUTTONS.deleteChat).text(MAIN_BUTTONS.topicSettings).row();
}

function buildMainKeyboard(currentModel: ModelInfo, options: MainKeyboardOptions = {}): Keyboard {
  const keyboard = new Keyboard();
  addQueuedPromptButtons(keyboard, options.queuedPromptLabels ?? []);
  if (options.isTopic === true) {
    addTopicControls(
      keyboard,
      options.paused ?? false,
      options.running ?? false,
      options.compactOutputMode ?? false,
      options.currentModel ?? currentModel,
    );
  } else {
    addMainControls(keyboard);
  }
  // Reply keyboards are chat-scoped in Telegram. Do not make them persistent:
  // the router actively removes stale Topic controls when Main/General is used.
  return keyboard.resized();
}

/** Canonical Main/General navigation. Model choices live under Settings → Default Models. */
export function createMainInlineKeyboard(_currentModel: ModelInfo): InlineKeyboard {
  return new InlineKeyboard()
    .text(MAIN_BUTTONS.newChat, "main:new")
    .row()
    .text(MAIN_BUTTONS.history, "main:history")
    .text(MAIN_BUTTONS.mainSettings, "main:settings");
}

/** Keyboard used exclusively inside an AI Topic backed by an OpenCode session. */
export function createTopicKeyboard(options: { paused?: boolean; running?: boolean; compactOutputMode?: boolean; currentModel?: ModelInfo } = {}): Keyboard {
  return buildMainKeyboard(
    options.currentModel ?? { providerID: "", modelID: "" },
    { ...options, isTopic: true },
  );
}

export function createMainKeyboard(currentModel: ModelInfo, options?: MainKeyboardOptions): Keyboard;
export function createMainKeyboard(_currentAgent: string, currentModel: ModelInfo, _contextInfo?: ContextInfo, _variantName?: string, queuedPromptLabels?: string[], paused?: boolean, running?: boolean): Keyboard;
export function createMainKeyboard(first: ModelInfo | string, second?: MainKeyboardOptions | ModelInfo, _contextInfo?: ContextInfo, _variantName?: string, queuedPromptLabels: string[] = [], paused = false, running = false): Keyboard {
  if (typeof first !== "string") return buildMainKeyboard(first, (second as MainKeyboardOptions | undefined) ?? {});
  return buildMainKeyboard(second as ModelInfo, { queuedPromptLabels, paused, running, isTopic: false });
}

export function createAgentKeyboard(currentAgent: string): Keyboard {
  return new Keyboard().text(getAgentButtonLabel(currentAgent)).row().resized();
}
