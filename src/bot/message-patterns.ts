export const AGENT_MODE_BUTTON_TEXT_PATTERN = /^(📋|🛠️|💬|🔍|📝|📄|📦|🤖)\s.+\s(?:Mode|Agent)$/;

// The model button is dynamic, but it is generated from normalized model names.
// Require either a known model-family token or a version/variant digit so a
// normal prompt such as "🧠 Explain this architecture" cannot be swallowed by
// the keyboard guard and routed away from prompt handling.
export const MODEL_BUTTON_TEXT_PATTERN = /^🧠\s(?:(?:(?:GPT|ChatGPT|Claude|DeepSeek|Gemini|GLM|Grok|Kimi|Llama|Mistral|MiniMax|Qwen|Yi|Command|Nova|Sonnet|Opus|Haiku|o[1-9]|r[1-9])\b.*)|.*\d.*)$/i;
export const VARIANT_BUTTON_TEXT_PATTERN = /^(💡|💭)\s.+$/;
export const CONTEXT_BUTTON_TEXT_PATTERN = /^📊(?:\s|$)/;
export const QUEUED_PROMPT_BUTTON_TEXT_PATTERN = /^❌\s\d+\.\s/;
export const ROOT_REPLY_BUTTON_TEXT_PATTERN = /^(?:🕘 History|💬 New Chat|🧠\s(?:(?:(?:GPT|ChatGPT|Claude|DeepSeek|Gemini|GLM|Grok|Kimi|Llama|Mistral|MiniMax|Qwen|Yi|Command|Nova|Sonnet|Opus|Haiku|o[1-9]|r[1-9])\b.*)|.*\d.*)|⚙️ Settings|🎨 Image AI|📦 Compact: (?:ON|OFF)|⏸️ Pause|▶️ Resume|🛑 Abort)$/i;

const REPLY_KEYBOARD_BUTTON_TEXT_PATTERNS = [
  AGENT_MODE_BUTTON_TEXT_PATTERN,
  MODEL_BUTTON_TEXT_PATTERN,
  VARIANT_BUTTON_TEXT_PATTERN,
  CONTEXT_BUTTON_TEXT_PATTERN,
  QUEUED_PROMPT_BUTTON_TEXT_PATTERN,
  ROOT_REPLY_BUTTON_TEXT_PATTERN,
];

export function isReplyKeyboardButtonText(text: string): boolean {
  return REPLY_KEYBOARD_BUTTON_TEXT_PATTERNS.some((pattern) => pattern.test(text.trim()));
}
