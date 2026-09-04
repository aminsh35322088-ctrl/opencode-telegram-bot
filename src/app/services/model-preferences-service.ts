import fs from "node:fs/promises";
import path from "node:path";
import type { FavoriteModel } from "../types/model.js";

const MAX_RECENT_MODELS = 10;
const MODEL_STATE_FILENAME = "model-preferences.json";
interface StoredModelRef { providerID?: string; modelID?: string; name?: string; variant?: string; }
interface ModelPreferencesState { favorite?: StoredModelRef[]; recent?: StoredModelRef[]; [key: string]: unknown; }

// Keep Telegram bot preferences in their own namespace. OpenCode owns
// ~/.local/state/opencode/model.json, so sharing that path can cause OpenCode
// startup/state reconciliation to overwrite the bot's favorites and recents.
function getModelStatePath(): string {
  const root = process.env.OPENCODE_TELEGRAM_HOME?.trim() || process.env.HOME || process.env.USERPROFILE || "/data";
  return path.join(root, "model-preferences", MODEL_STATE_FILENAME);
}

function key(model: FavoriteModel): string { return `${model.providerID}/${model.modelID}`; }

function normalize(models: unknown): FavoriteModel[] {
  if (!Array.isArray(models)) return [];
  return models.flatMap((model) => {
    if (typeof model !== "object" || model === null) return [];
    const item = model as StoredModelRef;
    return typeof item.providerID === "string" && item.providerID && typeof item.modelID === "string" && item.modelID
      ? [{ providerID: item.providerID, modelID: item.modelID, ...(item.name ? { name: item.name } : {}), ...(item.variant ? { variant: item.variant as FavoriteModel["variant"] } : {}) }]
      : [];
  });
}

async function readState(): Promise<ModelPreferencesState> {
  try {
    return JSON.parse(await fs.readFile(getModelStatePath(), "utf8")) as ModelPreferencesState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writeState(state: ModelPreferencesState): Promise<void> {
  const statePath = getModelStatePath();
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(state, null, 2), { mode: 0o600 });
  await fs.rename(tempPath, statePath);
}

export async function getFavoriteModels(): Promise<FavoriteModel[]> { return normalize((await readState()).favorite); }
export async function getRecentModels(): Promise<FavoriteModel[]> { return normalize((await readState()).recent).slice(0, MAX_RECENT_MODELS); }
export async function isFavoriteModel(model: FavoriteModel): Promise<boolean> { return (await getFavoriteModels()).some((item) => key(item) === key(model)); }
export async function toggleFavoriteModel(model: FavoriteModel): Promise<boolean> {
  const state = await readState();
  const favorites = normalize(state.favorite);
  const modelKey = key(model);
  const exists = favorites.some((item) => key(item) === modelKey);
  state.favorite = exists ? favorites.filter((item) => key(item) !== modelKey) : [...favorites, model];
  await writeState(state);
  return !exists;
}
export async function recordRecentModel(model: FavoriteModel): Promise<void> {
  const state = await readState();
  const modelKey = key(model);
  const recent = normalize(state.recent).filter((item) => key(item) !== modelKey);
  state.recent = [model, ...recent].slice(0, MAX_RECENT_MODELS);
  await writeState(state);
}
