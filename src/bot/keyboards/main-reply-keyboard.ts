import { Keyboard } from "grammy";
import { getAgentButtonLabel } from "../../app/types/agent.js";
import { formatModelForButton, type ModelInfo } from "../../app/types/model.js";
import type { ContextInfo } from "./keyboard-types.js";
import { isChatPaused } from "../../app/managers/paused-session-manager.js";
import { getCompactOutputMode } from "../../app/stores/settings-store.js";
import { getActiveTelegramTopic } from "../services/telegram-topic-runtime.js";

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
} as const;

export const TOPIC_BUTTONS = {
  abort: MAIN_BUTTONS.abort,
  pause: MAIN_BUTTONS.pause,
  resume: MAIN_BUTTONS.resume,
  imageAi: MAIN_BUTTONS.imageAi,
  modelCenter: "🧠 Model Center",
  deleteChat: MAIN_BUTTONS.deleteChat,
  topicSettings: MAIN_BUTTONS.topicSettings,
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

function getSettingsButton(isTopic: boolean): string {
  return isTopic ? MAIN_BUTTONS.topicSettings : MAIN_BUTTONS.mainSettings;
}

function addQueuedPromptButtons(keyboard: Keyboard, labels: string[]): void {
  for (const label of labels) keyboard.text(label).row();
}

function addControls(
  keyboard: Keyboard,
  currentModel: ModelInfo,
  isTopic: boolean,
  paused: boolean,
  running: boolean,
  compact: boolean,
): void {
  if (running || paused) {
    keyboard.text(paused ? MAIN_BUTTONS.resume : MAIN_BUTTONS.pause).text(MAIN_BUTTONS.abort).row();
  } else {
    keyboard.text(MAIN_BUTTONS.history).text(MAIN_BUTTONS.newChat).row();
  }

  if (!running && !paused) {
    keyboard.text(MAIN_BUTTONS.imageAi).text(MAIN_BUTTONS.compact(compact)).row();
  } else {
    keyboard.text(MAIN_BUTTONS.imageAi).row();
  }

  keyboard.text(getModelButtonLabel(currentModel)).row();
  keyboard.text(getSettingsButton(isTopic));
  if (isTopic) keyboard.text(MAIN_BUTTONS.deleteChat);
  keyboard.row();
}

function buildMainKeyboard(currentModel: ModelInfo, options: MainKeyboardOptions = {}): Keyboard {
  const keyboard = new Keyboard();
  const isTopic = options.isTopic ?? Boolean(getActiveTelegramTopic());
  addQueuedPromptButtons(keyboard, options.queuedPromptLabels ?? []);
  addControls(
    keyboard,
    currentModel,
    isTopic,
    options.paused ?? isChatPaused(),
    options.running ?? false,
    options.compactOutputMode ?? getCompactOutputMode(),
  );
  return keyboard.resized().persistent();
}

/**
 * Keyboard used exclusively inside a Telegram Topic backed by an OpenCode session.
 * Pause and Resume are one toggle: only the action matching the current state
 * is rendered. Abort remains available to terminate the current run.
 */
export function createTopicKeyboard(options: { paused?: boolean; running?: boolean } = {}): Keyboard {
  const paused = Boolean(options.paused);
  const toggleButton = paused ? TOPIC_BUTTONS.resume : TOPIC_BUTTONS.pause;

  return new Keyboard()
    .text(toggleButton)
    .text(TOPIC_BUTTONS.abort)
    .row()
    .text(TOPIC_BUTTONS.imageAi)
    .text(TOPIC_BUTTONS.modelCenter)
    .row()
    .text(TOPIC_BUTTONS.deleteChat)
    .text(TOPIC_BUTTONS.topicSettings)
    .row()
    .resized()
    .persistent();
}

export function createMainKeyboard(currentModel: ModelInfo, options?: MainKeyboardOptions): Keyboard;
export function createMainKeyboard(
  _currentAgent: string,
  currentModel: ModelInfo,
  _contextInfo?: ContextInfo,
  _variantName?: string,
  queuedPromptLabels?: string[],
  paused?: boolean,
  running?: boolean,
): Keyboard;
export function createMainKeyboard(
  first: ModelInfo | string,
  second?: MainKeyboardOptions | ModelInfo,
  _contextInfo?: ContextInfo,
  _variantName?: string,
  queuedPromptLabels: string[] = [],
  paused = false,
  running = false,
): Keyboard {
  if (typeof first !== "string") {
    return buildMainKeyboard(first, (second as MainKeyboardOptions | undefined) ?? {});
  }
  return buildMainKeyboard(second as ModelInfo, { queuedPromptLabels, paused, running });
}

export function createAgentKeyboard(currentAgent: string): Keyboard {
  return new Keyboard().text(getAgentButtonLabel(currentAgent)).row().resized().persistent();
}

export function removeKeyboard(): { remove_keyboard: true } {
  return { remove_keyboard: true };
}
