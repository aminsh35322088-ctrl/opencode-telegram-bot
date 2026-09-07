import type { ModelInfo } from "../types/model.js";
import { resolveCatalogModel } from "./model-selection-service.js";
import { readAppState, updateAppState } from "../stores/app-state-store.js";
import { logger } from "../../utils/logger.js";

export type AiRole = "coding" | "image" | "video" | "stt";
export interface AiRoleSelection {
  coding?: { providerID: string; modelID: string };
  image?: { providerID: string; modelID: string };
  video?: { providerID: string; modelID: string };
  stt?: { providerID: string; modelID: string };
}

const AI_ROLES: readonly AiRole[] = ["coding", "image", "video", "stt"];
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function isValidRoleModel(value: unknown): value is { providerID: string; modelID: string } { return isRecord(value) && typeof value.providerID === "string" && value.providerID.trim().length > 0 && typeof value.modelID === "string" && value.modelID.trim().length > 0; }
function normalizeRoleSelection(value: unknown): AiRoleSelection {
  if (!isRecord(value)) return {};
  const selections: AiRoleSelection = {};
  for (const role of AI_ROLES) {
    const candidate = value[role];
    if (!isValidRoleModel(candidate)) continue;
    selections[role] = { providerID: candidate.providerID.trim(), modelID: candidate.modelID.trim() };
  }
  return selections;
}

async function readSelections(): Promise<AiRoleSelection> {
  const state = await readAppState();
  return normalizeRoleSelection(state.aiRoles);
}
async function writeSelections(selections: AiRoleSelection): Promise<void> { await updateAppState({ aiRoles: selections }); }

export async function getAiRoleSelections(): Promise<AiRoleSelection> { return { ...(await readSelections()) }; }
export async function getAiRoleSelection(role: AiRole): Promise<{ providerID: string; modelID: string } | undefined> { return (await readSelections())[role]; }
export async function setAiRoleSelection(role: AiRole, providerID: string, modelID: string): Promise<void> {
  if (!AI_ROLES.includes(role)) throw new Error(`Unknown AI role: ${role}`);
  const normalizedProviderID = providerID.trim(); const normalizedModelID = modelID.trim();
  if (!normalizedProviderID || !normalizedModelID) throw new Error("AI role selection requires a provider and model.");
  const selections = await readSelections(); selections[role] = { providerID: normalizedProviderID, modelID: normalizedModelID }; await writeSelections(selections);
}
export async function getModelForRole(role: AiRole, fallback: ModelInfo): Promise<ModelInfo> {
  const selection = await getAiRoleSelection(role);
  if (!selection?.providerID || !selection.modelID) return fallback;
  const resolved = await resolveCatalogModel(selection.providerID, selection.modelID);
  if (!resolved) { logger.warn(`[AI Rules] Ignoring unavailable ${role} model ${selection.providerID}/${selection.modelID}; using fallback ${fallback.providerID}/${fallback.modelID}`); return fallback; }
  return { ...fallback, providerID: resolved.providerID, modelID: resolved.modelID, variant: "default" };
}
export async function clearAiRoleSelection(role: AiRole): Promise<void> { const selections = await readSelections(); delete selections[role]; await writeSelections(selections); }
export const AI_ROLE_LABELS: Record<AiRole, string> = { coding: "💻 Coding AI", image: "🎨 Image AI", video: "🎬 Video AI", stt: "🎙️ Speech-to-Text" };