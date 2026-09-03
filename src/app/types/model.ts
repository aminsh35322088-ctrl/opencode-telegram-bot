/**
 * Model types and formatting utilities
 */

export interface ModelInfo {
  providerID: string;
  modelID: string;
  variant?: string | undefined;
}

export interface VariantInfo {
  id: string;
  disabled?: boolean | undefined;
}

export interface FavoriteModel {
  providerID: string;
  modelID: string;
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

/**
 * Format the current model for the persistent reply keyboard.
 * Keep it on one line and bound the total label length so long model/provider
 * IDs cannot make the full-width button visually uneven.
 */
export function formatModelForButton(providerID: string, modelID: string): string {
  const prefix = "🧠 ";
  const separator = " · ";
  const available = MODEL_BUTTON_MAX_LENGTH - prefix.length;
  const combined = `${modelID}${separator}${providerID}`;

  if (combined.length <= available) return `${prefix}${combined}`;

  const modelBudget = Math.max(8, Math.floor((available - separator.length) * 0.62));
  const providerBudget = Math.max(8, available - separator.length - modelBudget);

  return `${prefix}${truncateLabel(modelID, modelBudget)}${separator}${truncateLabel(providerID, providerBudget)}`;
}

/**
 * Format model for display in messages (full format)
 * @param providerID Provider ID
 * @param modelID Model ID
 * @returns Formatted string "providerID / modelID"
 */
export function formatModelForDisplay(providerID: string, modelID: string): string {
  return `${providerID} / ${modelID}`;
}
