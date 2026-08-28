import { Keyboard } from "grammy";
import { getAgentButtonLabel } from "../../app/types/agent.js";
import { formatModelForButton } from "../../app/types/model.js";
import type { ModelInfo } from "../../app/types/model.js";
import type { ContextInfo } from "./keyboard-types.js";
import { t } from "../../i18n/index.js";

function formatTokenCount(count: number): string {
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
  if (count >= 1000) return `${Math.round(count / 1000)}K`;
  return count.toString();
}

function formatContextForButton(contextInfo: ContextInfo): string {
  const used = formatTokenCount(contextInfo.tokensUsed);
  const limit = formatTokenCount(contextInfo.tokensLimit);
  const percent = Math.round((contextInfo.tokensUsed / contextInfo.tokensLimit) * 100);
  return t("keyboard.context", { used, limit, percent });
}

export function createMainKeyboard(
  currentAgent: string,
  currentModel: ModelInfo,
  contextInfo?: ContextInfo,
  variantName?: string,
  queuedPromptLabels: string[] = [],
): Keyboard {
  const keyboard = new Keyboard();
  const agentText = getAgentButtonLabel(currentAgent);
  const modelText = formatModelForButton(currentModel.providerID, currentModel.modelID);
  const contextText = contextInfo ? formatContextForButton(contextInfo) : t("keyboard.context_empty");
  const variantText = variantName || t("keyboard.variant_default");

  for (const label of queuedPromptLabels) keyboard.text(label).row();

  // Core controls stay compact; navigation/setup lives in the lower row.
  keyboard.text(agentText).text(contextText).row();
  keyboard.text(modelText).text(variantText).row();
  keyboard.text("💬 New Chat").text("📁 Projects").row();
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
