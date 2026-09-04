export const AGENT_MODE_BUTTON_TEXT_PATTERN = /^(📋|🛠️|💬|🔍|📝|📄|📦|🤖)\s.+\s(?:Mode|Agent)$/;

// Model labels are dynamic. Keep the legacy heuristic narrow enough that a
// normal prompt such as "🧠 Explain this architecture" is still a prompt;
// the router also checks the exact labels currently rendered in the keyboard.
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

export function isReplyKeyboardButtonText(text: string, knownButtonTexts?: ReadonlySet<string>): boolean {
  const normalized = text.trim();
  if (knownButtonTexts?.has(normalized)) return true;
  return REPLY_KEYBOARD_BUTTON_TEXT_PATTERNS.some((pattern) => pattern.test(normalized));
}
