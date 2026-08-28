import { Keyboard } from "grammy";
import { getAgentButtonLabel } from "../../app/types/agent.js";
import { formatModelForButton } from "../../app/types/model.js";
import type { ModelInfo } from "../../app/types/model.js";
import type { ContextInfo } from "./keyboard-types.js";
import { isChatPaused } from "../../app/managers/paused-session-manager.js";

export function createMainKeyboard(
  _currentAgent: string,
  currentModel: ModelInfo,
  _contextInfo?: ContextInfo,
  _variantName?: string,
  queuedPromptLabels: string[] = [],
  paused = false,
  running = false,
): Keyboard {
  const keyboard = new Keyboard();
  const modelText = formatModelForButton(currentModel.providerID, currentModel.modelID);
  const effectivePaused = paused || isChatPaused();

  for (const label of queuedPromptLabels) keyboard.text(label).row();

  if (running) {
    keyboard.text(effectivePaused ? "▶️ Resume" : "⏸️ Pause").text("🛑 Abort").row();
    return keyboard.resized().persistent();
  }

  keyboard.text(modelText).text("💬 New Chat").row();
  if (effectivePaused) {
    keyboard.text("▶️ Resume").text("🛑 Abort").row();
  } else {
    keyboard.text("🕘 History").row();
    keyboard.text("⚙️ Settings").row();
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
