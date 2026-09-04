/**
 * Model types and formatting utilities
 */

export interface ModelInfo {
  providerID: string;
  modelID: string;
  name?: string | undefined;
  variant?: string | undefined;
}

export interface VariantInfo {
  id: string;
  disabled?: boolean | undefined;
}

export interface FavoriteModel {
  providerID: string;
  modelID: string;
  name?: string | undefined;
}

export interface ProviderInfo {
  id: string;
  name: string;
  modelCount: number;
}

export interface ModelSelectionLists {
  favorites: FavoriteModel[];
  recent: FavoriteModel[];
}

const MODEL_BUTTON_MAX_LENGTH = 48;

function truncateLabel(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(1, maxLength - 1))}…`;
}

const MODEL_TOKEN_CASE: Record<string, string> = {
  ai: "AI",
  api: "API",
  chatgpt: "ChatGPT",
  claude: "Claude",
  deepseek: "DeepSeek",
  gemini: "Gemini",
  glm: "GLM",
  gpt: "GPT",
  grok: "Grok",
  kimi: "Kimi",
  llama: "Llama",
  mistral: "Mistral",
  minimax: "MiniMax",
  qwen: "Qwen",
};

/**
 * Convert a provider model ID/name into a compact, human-friendly label.
 * The original provider/model IDs remain untouched for selection and API calls.
 */
export function formatModelName(modelID: string, advertisedName?: string): string {
  const raw = advertisedName?.trim() || modelID.trim();
  const withoutNamespace = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  const normalized = withoutNamespace
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([0-9])/gi, "$1 $2")
    .replace(/([0-9])([a-z])/gi, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return modelID;

  return normalized
    .split(" ")
    .map((part) => MODEL_TOKEN_CASE[part.toLowerCase()] ?? part)
    .join(" ");
}

/**
 * Format the active model for the persistent reply keyboard.
 * Only the model name is shown; provider/company names are intentionally omitted.
 */
export function formatModelForButton(_providerID: string, modelID: string, advertisedName?: string): string {
  const prefix = "🧠 ";
  const label = formatModelName(modelID, advertisedName);
  const available = MODEL_BUTTON_MAX_LENGTH - prefix.length;
  return `${prefix}${truncateLabel(label, available)}`;
}

/**
 * Format a model for user-facing messages without exposing the provider ID.
 */
export function formatModelForDisplay(_providerID: string, modelID: string, advertisedName?: string): string {
  return formatModelName(modelID, advertisedName);
}
