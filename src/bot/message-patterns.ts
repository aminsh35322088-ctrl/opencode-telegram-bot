export const MAIN_SETTINGS_BUTTON_TEXT = "⚙️ Main Settings";
export const TOPIC_SETTINGS_BUTTON_TEXT = "⚙️ Topic Settings";
export const LEGACY_SETTINGS_BUTTON_TEXT = "⚙️ Settings";

export const AGENT_MODE_BUTTON_TEXT_PATTERN = /^(📋|🛠|💬|🔍|📝|📄|📦|🤖)\s.+\s(?:Mode|Agent)$/;
export const MODEL_BUTTON_TEXT_PATTERN = /^🧠\s.+$/u;
export const VARIANT_BUTTON_TEXT_PATTERN = /^(💡|💭)\s.+$/;
export const CONTEXT_BUTTON_TEXT_PATTERN = /^📊(?:\s|$)/;
export const QUEUED_PROMPT_BUTTON_TEXT_PATTERN = /^❌\s\d+\.\s/;
export const ROOT_REPLY_BUTTON_TEXT_PATTERN = /^(?:🕘 History|💬 New Chat|⚙️ Main Settings|⚙️ Topic Settings|⚙️ Settings|🎨 Image AI|🗑️ Delete Chat|📦 Compact: (?:ON|OFF)|⏸️ Pause|▶️ Resume|🛑 Abort)$/u;
const REPLY_KEYBOARD_BUTTON_TEXT_PATTERNS = [AGENT_MODE_BUTTON_TEXT_PATTERN, MODEL_BUTTON_TEXT_PATTERN, VARIANT_BUTTON_TEXT_PATTERN, CONTEXT_BUTTON_TEXT_PATTERN, QUEUED_PROMPT_BUTTON_TEXT_PATTERN, ROOT_REPLY_BUTTON_TEXT_PATTERN];
function normalizeReplyKeyboardText(text: string): string { return text.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim(); }
function presentationInvariant(text: string): string { return normalizeReplyKeyboardText(text).replace(/\uFE0F/g, ""); }
const STATIC_REPLY_KEYBOARD_LABELS = new Set<string>([MAIN_SETTINGS_BUTTON_TEXT, TOPIC_SETTINGS_BUTTON_TEXT, LEGACY_SETTINGS_BUTTON_TEXT, "🕘 History", "💬 New Chat", "🎨 Image AI", "🗑️ Delete Chat", "📦 Compact: ON", "📦 Compact: OFF", "⏸️ Pause", "▶️ Resume", "🛑 Abort"]);
const NORMALIZED_STATIC_REPLY_KEYBOARD_LABELS = new Set([...STATIC_REPLY_KEYBOARD_LABELS].map(presentationInvariant));
export function isReplyKeyboardButtonText(text: string, knownButtonTexts?: ReadonlySet<string>): boolean {
  const normalized = presentationInvariant(text);
  if (knownButtonTexts) for (const knownText of knownButtonTexts) if (presentationInvariant(knownText) === normalized) return true;
  if (NORMALIZED_STATIC_REPLY_KEYBOARD_LABELS.has(normalized)) return true;
  return REPLY_KEYBOARD_BUTTON_TEXT_PATTERNS.some((pattern) => pattern.test(normalized));
}
