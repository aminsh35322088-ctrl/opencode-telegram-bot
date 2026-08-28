import { Keyboard } from "grammy";
import { getAgentButtonLabel } from "../../app/types/agent.js";
import { formatModelForButton } from "../../app/types/model.js";
import type { ModelInfo } from "../../app/types/model.js";
import type { ContextInfo } from "./keyboard-types.js";

export function createMainKeyboard(
  _currentAgent: string,
  currentModel: ModelInfo,
  _contextInfo?: ContextInfo,
  _variantName?: string,
  queuedPromptLabels: string[] = [],
  paused = false,
): Keyboard {
  const keyboard = new Keyboard();
  const modelText = formatModelForButton(currentModel.providerID, currentModel.modelID);

  for (const label of queuedPromptLabels) keyboard.text(label).row();

  keyboard.text(modelText).text("💬 New Chat").row();
  keyboard.text(paused ? "▶️ Resume" : "⏸️ Pause").text("🕘 History").row();
  keyboard.text("⚙️ Settings").row();

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
