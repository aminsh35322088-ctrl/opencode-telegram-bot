export const AGENT_MODE_BUTTON_TEXT_PATTERN = /^(📋|🛠️|💬|🔍|📝|📄|📦|🤖)\s.+\s(?:Mode|Agent)$/;

// Kept for dedicated model routing/tests. Dynamic model labels are matched
// exactly by the router against the label currently rendered in the keyboard.
export const MODEL_BUTTON_TEXT_PATTERN = /^🧠\s.+$/;
export const VARIANT_BUTTON_TEXT_PATTERN = /^(💡|💭)\s.+$/;
export const CONTEXT_BUTTON_TEXT_PATTERN = /^📊(?:\s|$)/;
export const QUEUED_PROMPT_BUTTON_TEXT_PATTERN = /^❌\s\d+\.\s/;
export const ROOT_REPLY_BUTTON_TEXT_PATTERN = /^(?:🕘 History|💬 New Chat|⚙️ Settings|🎨 Image AI|📦 Compact: (?:ON|OFF)|⏸️ Pause|▶️ Resume|🛑 Abort)$/;

const REPLY_KEYBOARD_BUTTON_TEXT_PATTERNS = [
  AGENT_MODE_BUTTON_TEXT_PATTERN,
  VARIANT_BUTTON_TEXT_PATTERN,
  CONTEXT_BUTTON_TEXT_PATTERN,
  QUEUED_PROMPT_BUTTON_TEXT_PATTERN,
  ROOT_REPLY_BUTTON_TEXT_PATTERN,
];

export function isReplyKeyboardButtonText(text: string, knownButtonTexts?: ReadonlySet<string>): boolean {
  const normalized = text.trim();
  if (knownButtonTexts?.has(normalized)) return true;
  return REPLY_KEYBOARD_BUTTON_TEXT_PATTERNS.some((pattern) => pattern.test(normalized));
}
