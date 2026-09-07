export const MAIN_SETTINGS_BUTTON_TEXT = "⚙️ Main Settings";
export const TOPIC_SETTINGS_BUTTON_TEXT = "⚙️ Topic Settings";
export const LEGACY_SETTINGS_BUTTON_TEXT = "⚙️ Settings";
export const MODEL_CENTER_BUTTON_TEXT = "🧠 Model Center";

export const AGENT_MODE_BUTTON_TEXT_PATTERN = /^(📋|🛠|💬|🔍|📝|📄|📦|🤖)\s.+\s(?:Mode|Agent)$/;
export const MODEL_BUTTON_TEXT_PATTERN = /^🧠\s.+$/u;
export const VARIANT_BUTTON_TEXT_PATTERN = /^(💡|💭)\s.+$/u;
export const CONTEXT_BUTTON_TEXT_PATTERN = /^📊(?:\s|$)/u;
export const QUEUED_PROMPT_BUTTON_TEXT_PATTERN = /^❌\s\d+\.\s/;
export const ROOT_REPLY_BUTTON_TEXT_PATTERN = /^(?:🕘 History|💬 New Chat|⚙️ Main Settings|⚙️ Topic Settings|⚙️ Settings|🎨 Image AI|🗑️ Delete Chat|📦 Compact: (?:ON|OFF)|⏸️ Pause|▶️ Resume|🛑 Abort|🧠 Model Center)$/u;

const REPLY_KEYBOARD_BUTTON_TEXT_PATTERNS = [
  AGENT_MODE_BUTTON_TEXT_PATTERN,
  MODEL_BUTTON_TEXT_PATTERN,
  VARIANT_BUTTON_TEXT_PATTERN,
  CONTEXT_BUTTON_TEXT_PATTERN,
  QUEUED_PROMPT_BUTTON_TEXT_PATTERN,
  ROOT_REPLY_BUTTON_TEXT_PATTERN,
];

function normalizeReplyKeyboardText(text: string): string {
  return text.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\uFE0F/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Legacy/pattern-based classifier used only by downstream Telegram handlers.
 *
 * When the caller supplies the buttons that are actually rendered in the
 * current Telegram context, that exact registry is authoritative. Never fall
 * back to broad emoji/prefix patterns in that mode: doing so can classify an
 * ordinary prompt as a keyboard control, and (more importantly) can make the
 * caller skip the real control handler and continue into prompt processing.
 */
export function isReplyKeyboardButtonText(text: string, knownButtonTexts?: ReadonlySet<string>): boolean {
  const normalized = normalizeReplyKeyboardText(text);
  if (knownButtonTexts) {
    for (const knownText of knownButtonTexts) {
      if (normalizeReplyKeyboardText(knownText) === normalized) return true;
    }
    return false;
  }

  return REPLY_KEYBOARD_BUTTON_TEXT_PATTERNS.some((pattern) => pattern.test(normalized));
}
