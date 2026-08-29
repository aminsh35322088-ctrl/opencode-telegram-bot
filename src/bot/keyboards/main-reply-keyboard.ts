import { Keyboard } from "grammy";
import { getAgentButtonLabel } from "../../app/types/agent.js";
import { formatModelForButton } from "../../app/types/model.js";
import type { ModelInfo } from "../../app/types/model.js";
import type { ContextInfo } from "./keyboard-types.js";
import { isChatPaused } from "../../app/managers/paused-session-manager.js";
import { getCompactOutputMode } from "../../app/stores/settings-store.js";

const MAIN_BUTTONS = {
  history: "🕘 History",
  newChat: "💬 New Chat",
  settings: "⚙️ Settings",
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

function addPausedControls(keyboard: Keyboard, modelText: string): void {
  keyboard.text(modelText).text(MAIN_BUTTONS.newChat).row();
  keyboard.text(MAIN_BUTTONS.resume).text(MAIN_BUTTONS.abort).row();
}

function buildMainKeyboard(currentModel: ModelInfo, options: MainKeyboardOptions = {}): Keyboard {
  const keyboard = new Keyboard();
  const modelText = formatModelForButton(currentModel.providerID, currentModel.modelID);
  const effectivePaused = options.paused ?? isChatPaused();

  addQueuedPromptButtons(keyboard, options.queuedPromptLabels ?? []);

  if (options.running) {
    addRunningControls(keyboard, effectivePaused);
    return keyboard.resized().persistent();
  }

  if (effectivePaused) {
    addPausedControls(keyboard, modelText);
  } else {
    addIdleControls(keyboard, modelText, options.compactOutputMode ?? getCompactOutputMode());
  }

  return keyboard.resized().persistent();
}

/** Current API: model + explicit keyboard options. */
export function createMainKeyboard(currentModel: ModelInfo, options?: MainKeyboardOptions): Keyboard;
/**
 * Compatibility API for existing presentation/callback callers. The legacy
 * agent/context/variant values were never rendered by this keyboard and are
 * intentionally ignored while the state refactor is finalized.
 */
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
  const keyboard = new Keyboard();
  keyboard.text(getAgentButtonLabel(currentAgent)).row();
  return keyboard.resized().persistent();
}

export function removeKeyboard(): { remove_keyboard: true } {
  return { remove_keyboard: true };
}

export { MAIN_BUTTONS };
