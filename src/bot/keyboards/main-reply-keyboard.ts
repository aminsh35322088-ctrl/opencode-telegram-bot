import { InlineKeyboard, Keyboard } from "grammy";
import { getAgentButtonLabel } from "../../app/types/agent.js";
import { formatModelForButton, type ModelInfo } from "../../app/types/model.js";
import type { ContextInfo } from "./keyboard-types.js";
import { getCompactOutputMode } from "../../app/stores/settings-store.js";

export const MAIN_BUTTONS = {
  history: "🕘 History",
  newChat: "💬 New Chat",
  mainSettings: "⚙️ Main Settings",
  topicSettings: "⚙️ Topic Settings",
  settings: "⚙️ Main Settings",
  imageAi: "🎨 Image AI",
  deleteChat: "🗑️ Delete Chat",
  compact: (enabled: boolean) => `📦 Compact: ${enabled ? "ON" : "OFF"}`,
  pause: "⏸️ Pause",
  resume: "▶️ Resume",
  abort: "🛑 Abort",
  hideKeyboard: "⌨️ Hide Keyboard",
} as const;

export const TOPIC_BUTTONS = {
  abort: MAIN_BUTTONS.abort,
  pause: MAIN_BUTTONS.pause,
  resume: MAIN_BUTTONS.resume,
  imageAi: MAIN_BUTTONS.imageAi,
  compact: (enabled: boolean) => MAIN_BUTTONS.compact(enabled),
  modelCenter: "🧠 Model Center",
  deleteChat: MAIN_BUTTONS.deleteChat,
  topicSettings: MAIN_BUTTONS.topicSettings,
  hideKeyboard: MAIN_BUTTONS.hideKeyboard,
} as const;

export const TOPIC_SETTINGS_BUTTON = MAIN_BUTTONS.topicSettings;
export interface MainKeyboardOptions {
  queuedPromptLabels?: string[];
  paused?: boolean;
  running?: boolean;
  compactOutputMode?: boolean;
  isTopic?: boolean;
}

function getModelButtonLabel(currentModel: ModelInfo): string {
  if (!currentModel.providerID || !currentModel.modelID) return "🧠 Model";
  return formatModelForButton(currentModel.providerID, currentModel.modelID, currentModel.name);
}

function addQueuedPromptButtons(keyboard: Keyboard, labels: string[]): void {
  for (const label of labels) keyboard.text(label).row();
}

function addHideKeyboardControl(keyboard: Keyboard): void {
  keyboard.text(MAIN_BUTTONS.hideKeyboard).row();
}

function addMainControls(keyboard: Keyboard, currentModel: ModelInfo): void {
  keyboard.text(MAIN_BUTTONS.history).text(MAIN_BUTTONS.newChat).row();
  keyboard.text(getModelButtonLabel(currentModel)).row();
  keyboard.text(MAIN_BUTTONS.mainSettings).row();
  addHideKeyboardControl(keyboard);
}

function addTopicControls(keyboard: Keyboard, paused: boolean, running: boolean, compact: boolean): void {
  if (running || paused) {
    keyboard.text(paused ? MAIN_BUTTONS.resume : MAIN_BUTTONS.pause).text(MAIN_BUTTONS.abort).row();
  }
  keyboard.text(MAIN_BUTTONS.deleteChat).text(MAIN_BUTTONS.compact(compact)).row();
  keyboard.text(TOPIC_BUTTONS.modelCenter).text(MAIN_BUTTONS.topicSettings).row();
  addHideKeyboardControl(keyboard);
}

function buildMainKeyboard(currentModel: ModelInfo, options: MainKeyboardOptions = {}): Keyboard {
  const keyboard = new Keyboard();
  const isTopic = options.isTopic === true;
  addQueuedPromptButtons(keyboard, options.queuedPromptLabels ?? []);
  if (isTopic) {
    addTopicControls(keyboard, options.paused ?? false, options.running ?? false, options.compactOutputMode ?? getCompactOutputMode());
  } else {
    addMainControls(keyboard, currentModel);
  }
  return keyboard.resized();
}

/** Normal/private-chat navigation stays on the existing inline UI. */
export function createMainInlineKeyboard(currentModel: ModelInfo): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  keyboard.text(MAIN_BUTTONS.history, "main:history").text(MAIN_BUTTONS.newChat, "main:new").row();
  keyboard.text(getModelButtonLabel(currentModel), "main:model").row();
  keyboard.text(MAIN_BUTTONS.mainSettings, "main:settings").row();
  return keyboard;
}

/** Reply Keyboard used by General/All after Topic Mode is active. */
export function createTopicMainKeyboard(currentModel: ModelInfo, queuedPromptLabels: string[] = []): Keyboard {
  return buildMainKeyboard(currentModel, {
    queuedPromptLabels,
    paused: false,
    running: false,
    compactOutputMode: getCompactOutputMode(),
    isTopic: false,
  });
}

/** Keyboard used exclusively inside an AI Topic backed by an OpenCode session. */
export function createTopicKeyboard(options: { paused?: boolean; running?: boolean; compactOutputMode?: boolean } = {}): Keyboard {
  return buildMainKeyboard({ providerID: "", modelID: "" }, { ...options, isTopic: true });
}

export function createMainKeyboard(currentModel: ModelInfo, options?: MainKeyboardOptions): Keyboard;
export function createMainKeyboard(_currentAgent: string, currentModel: ModelInfo, _contextInfo?: ContextInfo, _variantName?: string, queuedPromptLabels?: string[], paused?: boolean, running?: boolean): Keyboard;
export function createMainKeyboard(first: ModelInfo | string, second?: MainKeyboardOptions | ModelInfo, _contextInfo?: ContextInfo, _variantName?: string, queuedPromptLabels: string[] = [], paused = false, running = false): Keyboard {
  if (typeof first !== "string") return buildMainKeyboard(first, (second as MainKeyboardOptions | undefined) ?? {});
  return buildMainKeyboard(second as ModelInfo, { queuedPromptLabels, paused, running, isTopic: false });
}

/** Agent selection keyboard is also a Reply Keyboard, so it gets the same client-side hide control. */
export function createAgentKeyboard(currentAgent: string): Keyboard {
  const keyboard = new Keyboard().text(getAgentButtonLabel(currentAgent)).row();
  addHideKeyboardControl(keyboard);
  return keyboard.resized();
}

/** Telegram client-side custom keyboard removal. */
export function removeKeyboard(): { remove_keyboard: true } {
  return { remove_keyboard: true };
}
