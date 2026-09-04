export const AGENT_MODE_BUTTON_TEXT_PATTERN = /^(📋|🛠️|💬|🔍|📝|📄|📦|🤖)\s.+\s(?:Mode|Agent)$/;

// Kept for dedicated model routing/tests. The actual router matches the
// current rendered model label exactly, so arbitrary 🧠 prompts cannot collide.
export const MODEL_BUTTON_TEXT_PATTERN = /^🧠\s(?:(?:(?:GPT|ChatGPT|Claude|DeepSeek|Gemini|GLM|Grok|Kimi|Llama|Mistral|MiniMax|Qwen|Yi|Command|Nova|Sonnet|Opus|Haiku|o[1-9]|r[1-9])\b.*))$/i;
export const VARIANT_BUTTON_TEXT_PATTERN = /^(💡|💭)\s.+$/;
export const CONTEXT_BUTTON_TEXT_PATTERN = /^📊(?:\s|$)/;
export const QUEUED_PROMPT_BUTTON_TEXT_PATTERN = /^❌\s\d+\.\s/;
export const ROOT_REPLY_BUTTON_TEXT_PATTERN = /^(?:🕘 History|💬 New Chat|⚙️ Settings|🎨 Image AI|🗑️ Delete Chat|📦 Compact: (?:ON|OFF)|⏸️ Pause|▶️ Resume|🛑 Abort)$/;

const REPLY_KEYBOARD_BUTTON_TEXT_PATTERNS = [
  AGENT_MODE_BUTTON_TEXT_PATTERN,
  VARIANT_BUTTON_TEXT_PATTERN,
  CONTEXT_BUTTON_TEXT_PATTERN,
  QUEUED_PROMPT_BUTTON_TEXT_PATTERN,
  ROOT_REPLY_BUTTON_TEXT_PATTERN,
];

function normalizeReplyKeyboardText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\uFE0F/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isReplyKeyboardButtonText(text: string, knownButtonTexts?: ReadonlySet<string>): boolean {
  const normalized = normalizeReplyKeyboardText(text);
  if (knownButtonTexts) {
    for (const knownText of knownButtonTexts) {
      if (normalizeReplyKeyboardText(knownText) === normalized) return true;
    }
  }
  return REPLY_KEYBOARD_BUTTON_TEXT_PATTERNS.some((pattern) => pattern.test(normalized));
}
