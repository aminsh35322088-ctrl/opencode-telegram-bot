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

/**
 * Format the current model for the persistent reply keyboard.
 * Keep the model and provider intact: this button now has its own full-width row.
 */
export function formatModelForButton(providerID: string, modelID: string): string {
  return `🧠 ${modelID}\n${providerID}`;
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
