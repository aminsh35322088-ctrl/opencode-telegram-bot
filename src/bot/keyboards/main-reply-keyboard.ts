import { Keyboard } from "grammy";
import { getAgentButtonLabel } from "../../app/types/agent.js";
import { formatModelForButton, type ModelInfo } from "../../app/types/model.js";
import type { ContextInfo } from "./keyboard-types.js";
import { isChatPaused } from "../../app/managers/paused-session-manager.js";
import { getCompactOutputMode } from "../../app/stores/settings-store.js";

const MAIN_BUTTONS = {
  history: "🕘 History",
  newChat: "💬 New Chat",
  settings: "⚙️ Settings",
  imageAi: "🎨 Image AI",
  compact: (enabled: boolean) => `📦 Compact: ${enabled ? "ON" : "OFF"}`,
  pause: "⏸️ Pause",
  resume: "▶️ Resume",
  abort: "🛑 Abort",
} as const;

export interface MainKeyboardOptions {
  queuedPromptLabels?: string[];
  paused?: boolean;
  running?: boolean;
  compactOutputMode?: boolean;
}

function getModelButtonLabel(currentModel: ModelInfo): string {
  if (!currentModel.providerID || !currentModel.modelID) return "🧠 Model";
  return formatModelForButton(currentModel.providerID, currentModel.modelID, currentModel.name);
}

function addQueuedPromptButtons(keyboard: Keyboard, labels: string[]): void {
  for (const label of labels) keyboard.text(label).row();
}

function addRunningControls(keyboard: Keyboard, paused: boolean): void {
  keyboard.text(paused ? MAIN_BUTTONS.resume : MAIN_BUTTONS.pause).text(MAIN_BUTTONS.abort).row();
}

function addIdleControls(keyboard: Keyboard, currentModel: ModelInfo, compactOutputMode: boolean): void {
  keyboard.text(MAIN_BUTTONS.history).text(MAIN_BUTTONS.newChat).row();
  keyboard.text(MAIN_BUTTONS.imageAi).text(MAIN_BUTTONS.compact(compactOutputMode)).row();
  keyboard.text(getModelButtonLabel(currentModel)).row();
  keyboard.text(MAIN_BUTTONS.settings).row();
}

function addPausedControls(keyboard: Keyboard, currentModel: ModelInfo): void {
  keyboard.text(MAIN_BUTTONS.newChat).text(MAIN_BUTTONS.imageAi).row();
  keyboard.text(getModelButtonLabel(currentModel)).row();
  keyboard.text(MAIN_BUTTONS.resume).text(MAIN_BUTTONS.abort).row();
}

function buildMainKeyboard(currentModel: ModelInfo, options: MainKeyboardOptions = {}): Keyboard {
  const keyboard = new Keyboard();
  const effectivePaused = options.paused ?? isChatPaused();

  addQueuedPromptButtons(keyboard, options.queuedPromptLabels ?? []);

  if (options.running) {
    addRunningControls(keyboard, effectivePaused);
    return keyboard.resized().persistent();
  }

  if (effectivePaused) {
    addPausedControls(keyboard, currentModel);
  } else {
    addIdleControls(keyboard, currentModel, options.compactOutputMode ?? getCompactOutputMode());
  }

  return keyboard.resized().persistent();
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

  return buildMainKeyboard(second as ModelInfo, {
    queuedPromptLabels,
    paused,
    running,
  });
}

export function createAgentKeyboard(currentAgent: string): Keyboard {
  return new Keyboard().text(getAgentButtonLabel(currentAgent)).row().resized().persistent();
}

export function removeKeyboard(): { remove_keyboard: true } {
  return { remove_keyboard: true };
}

export { MAIN_BUTTONS };
