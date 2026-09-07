import { MAIN_BUTTONS, TOPIC_BUTTONS } from "./main-reply-keyboard.js";
import { keyboardManager } from "./keyboard-manager.js";
import { getTopicRuntimeContext } from "../../app/services/topic-runtime-context.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { formatModelForButton } from "../../app/types/model.js";

function normalize(text: string): string {
  return text.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\uFE0F/g, "").replace(/\s+/g, " ").trim();
}

function extractKeyboardTexts(keyboard: unknown): string[] {
  const rows = (keyboard as { keyboard?: Array<Array<{ text?: string }>> } | undefined)?.keyboard ?? [];
  return rows.flat().map((button) => button.text).filter((text): text is string => Boolean(text));
}

export function getCurrentReplyKeyboardLabels(): Set<string> {
  const runtime = getTopicRuntimeContext();
  const keyboard = keyboardManager.getKeyboard(runtime?.sessionId);
  const labels = new Set(extractKeyboardTexts(keyboard).map(normalize));
  const model = getStoredModel();
  const modelButton = model.providerID && model.modelID
    ? formatModelForButton(model.providerID, model.modelID, model.name)
    : "🧠 Model";

  for (const label of [
    "❌ Cancel",
    MAIN_BUTTONS.history,
    MAIN_BUTTONS.newChat,
    MAIN_BUTTONS.mainSettings,
    MAIN_BUTTONS.topicSettings,
    MAIN_BUTTONS.imageAi,
    MAIN_BUTTONS.deleteChat,
    MAIN_BUTTONS.compact(true),
    MAIN_BUTTONS.compact(false),
    MAIN_BUTTONS.pause,
    MAIN_BUTTONS.resume,
    MAIN_BUTTONS.abort,
    "🧠 Model Center",
    modelButton,
    TOPIC_BUTTONS.modelCenter(),
  ]) labels.add(normalize(label));

  return labels;
}

export function isCurrentReplyKeyboardLabel(text: string): boolean {
  return getCurrentReplyKeyboardLabels().has(normalize(text));
}
