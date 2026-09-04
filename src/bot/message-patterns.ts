export const AGENT_MODE_BUTTON_TEXT_PATTERN = /^(📋|🛠️|💬|🔍|📝|📄|📦|🤖)\s.+\s(?:Mode|Agent)$/;
export const MODEL_BUTTON_TEXT_PATTERN = /^🧠\s.+$/;
export const VARIANT_BUTTON_TEXT_PATTERN = /^(💡|💭)\s.+$/;
export const CONTEXT_BUTTON_TEXT_PATTERN = /^📊(?:\s|$)/;
export const QUEUED_PROMPT_BUTTON_TEXT_PATTERN = /^❌\s\d+\.\s/;
export const ROOT_REPLY_BUTTON_TEXT_PATTERN = /^(?:🕘 History|💬 New Chat|🧠\s.+|⚙️ Settings|🎨 Image AI|📦 Compact: (?:ON|OFF)|⏸️ Pause|▶️ Resume|🛑 Abort)$/;
const REPLY_KEYBOARD_BUTTON_TEXT_PATTERNS = [AGENT_MODE_BUTTON_TEXT_PATTERN, MODEL_BUTTON_TEXT_PATTERN, VARIANT_BUTTON_TEXT_PATTERN, CONTEXT_BUTTON_TEXT_PATTERN, QUEUED_PROMPT_BUTTON_TEXT_PATTERN, ROOT_REPLY_BUTTON_TEXT_PATTERN];
export function isReplyKeyboardButtonText(text: string): boolean { return REPLY_KEYBOARD_BUTTON_TEXT_PATTERNS.some((pattern) => pattern.test(text.trim())); }
