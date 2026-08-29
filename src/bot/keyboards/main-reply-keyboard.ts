import { Keyboard } from "grammy";
import { getAgentButtonLabel } from "../../app/types/agent.js";
import { formatModelForButton } from "../../app/types/model.js";
import type { ModelInfo } from "../../app/types/model.js";
import { isChatPaused } from "../../app/managers/paused-session-manager.js";

const MAIN_BUTTONS = {
  history: "🕘 History",
  newChat: "💬 New Chat",
  settings: "⚙️ Settings",
  compact: (enabled: boolean) => `📦 Compact: ${enabled ? "ON" : "OFF"}`,
  pause: "⏸️ Pause",
  resume: "▶️ Resume",
  abort: "🛑 Abort",
} as const;

interface MainKeyboardOptions {
  queuedPromptLabels?: string[];
  paused?: boolean;
  running?: boolean;
  compactOutputMode?: boolean;
}

function addQueuedPromptButtons(keyboard: Keyboard, labels: string[]): void {
  for (const label of labels) keyboard.text(label).row();
}

function addRunningControls(keyboard: Keyboard, paused: boolean): void {
  keyboard.text(paused ? MAIN_BUTTONS.resume : MAIN_BUTTONS.pause).text(MAIN_BUTTONS.abort).row();
}

function addIdleControls(keyboard: Keyboard, modelText: string, compactOutputMode: boolean): void {
  keyboard.text(MAIN_BUTTONS.history).text(MAIN_BUTTONS.newChat).row();
  keyboard.text(modelText).text(MAIN_BUTTONS.compact(compactOutputMode)).row();
  keyboard.text(MAIN_BUTTONS.settings).row();
}

export function createMainKeyboard(
  currentModel: ModelInfo,
  options: MainKeyboardOptions = {},
): Keyboard {
  const keyboard = new Keyboard();
  const modelText = formatModelForButton(currentModel.providerID, currentModel.modelID);
  const effectivePaused = options.paused ?? isChatPaused();

  addQueuedPromptButtons(keyboard, options.queuedPromptLabels ?? []);

  if (options.running) {
    addRunningControls(keyboard, effectivePaused);
    return keyboard.resized().persistent();
  }

  addIdleControls(keyboard, modelText, options.compactOutputMode ?? false);

  if (effectivePaused) {
    keyboard.text(MAIN_BUTTONS.resume).text(MAIN_BUTTONS.abort).row();
  }

  return keyboard.resized().persistent();
}

export function createAgentKeyboard(currentAgent: string): Keyboard {
  const keyboard = new Keyboard();
  keyboard.text(getAgentButtonLabel(currentAgent)).row();
  return keyboard.resized().persistent();
}

export function removeKeyboard(): { remove_keyboard: true } {
  return { remove_keyboard: true };
}

export { MAIN_BUTTONS };
