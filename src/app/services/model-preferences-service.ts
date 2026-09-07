import type { FavoriteModel } from "../types/model.js";
import { readAppState, updateAppState } from "../stores/app-state-store.js";

const MAX_RECENT_MODELS = 10;
interface StoredModelRef { providerID?: string; modelID?: string; name?: string; }
interface ModelPreferencesState { favorite?: StoredModelRef[]; recent?: StoredModelRef[]; [key: string]: unknown; }
function key(model: FavoriteModel): string { return `${model.providerID}/${model.modelID}`; }
function normalize(models: unknown): FavoriteModel[] {
  if (!Array.isArray(models)) return [];
  return models.flatMap((model) => {
    if (typeof model !== "object" || model === null) return [];
    const item = model as StoredModelRef;
    return typeof item.providerID === "string" && item.providerID && typeof item.modelID === "string" && item.modelID ? [{ providerID: item.providerID, modelID: item.modelID, ...(item.name ? { name: item.name } : {}) }] : [];
  });
}
async function readState(): Promise<ModelPreferencesState> { const state = await readAppState(); const value = state.modelPreferences; return value && typeof value === "object" && !Array.isArray(value) ? value as ModelPreferencesState : {}; }
async function writeState(state: ModelPreferencesState): Promise<void> { await updateAppState({ modelPreferences: { ...state } }); }
export async function getFavoriteModels(): Promise<FavoriteModel[]> { return normalize((await readState()).favorite); }
export async function getRecentModels(): Promise<FavoriteModel[]> { return normalize((await readState()).recent).slice(0, MAX_RECENT_MODELS); }
export async function isFavoriteModel(model: FavoriteModel): Promise<boolean> { return (await getFavoriteModels()).some((item) => key(item) === key(model)); }
export async function toggleFavoriteModel(model: FavoriteModel): Promise<boolean> { const state = await readState(); const favorites = normalize(state.favorite); const modelKey = key(model); const exists = favorites.some((item) => key(item) === modelKey); state.favorite = exists ? favorites.filter((item) => key(item) !== modelKey) : [...favorites, model]; await writeState(state); return !exists; }
export async function recordRecentModel(model: FavoriteModel): Promise<void> { const state = await readState(); const modelKey = key(model); const recent = normalize(state.recent).filter((item) => key(item) !== modelKey); state.recent = [model, ...recent].slice(0, MAX_RECENT_MODELS); await writeState(state); }
export async function clearAllModelPreferences(): Promise<void> { const state = await readAppState(); const next = { ...state }; delete next.modelPreferences; await updateAppState(next); }