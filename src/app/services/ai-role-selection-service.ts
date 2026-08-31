import fs from "node:fs/promises";
import path from "node:path";
import type { ModelInfo } from "../types/model.js";
import { getRuntimePaths } from "../../runtime/paths.js";
import { resolveCatalogModel } from "./model-selection-service.js";
import { logger } from "../../utils/logger.js";

export type AiRole = "coding" | "image" | "video" | "stt";
export interface AiRoleSelection { coding?: { providerID: string; modelID: string }; image?: { providerID: string; modelID: string }; video?: { providerID: string; modelID: string }; stt?: { providerID: string; modelID: string }; }
const FILE = "ai-role-selection.json";
function filePath(): string { return path.join(getRuntimePaths().appHome, FILE); }
async function read(): Promise<AiRoleSelection> { try { const value = JSON.parse(await fs.readFile(filePath(), "utf8")) as AiRoleSelection; return value && typeof value === "object" ? value : {}; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; } }
async function write(value: AiRoleSelection): Promise<void> { await fs.mkdir(path.dirname(filePath()), { recursive: true }); const temp = `${filePath()}.tmp`; await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); await fs.rename(temp, filePath()); }
export async function getAiRoleSelections(): Promise<AiRoleSelection> { return read(); }
export async function getAiRoleSelection(role: AiRole): Promise<{ providerID: string; modelID: string } | undefined> { const value = await read(); return value[role]; }
export async function setAiRoleSelection(role: AiRole, providerID: string, modelID: string): Promise<void> {
  const normalizedProviderID = providerID.trim();
  const normalizedModelID = modelID.trim();
  if (!normalizedProviderID || !normalizedModelID) throw new Error("AI role selection requires a provider and model.");
  const value = await read();
  value[role] = { providerID: normalizedProviderID, modelID: normalizedModelID };
  await write(value);
}
export async function getModelForRole(role: AiRole, fallback: ModelInfo): Promise<ModelInfo> {
  const selection = await getAiRoleSelection(role);
  if (!selection?.providerID?.trim() || !selection.modelID?.trim()) return fallback;
  const resolved = await resolveCatalogModel(selection.providerID, selection.modelID);
  if (!resolved) {
    logger.warn(`[AI Rules] Ignoring unavailable ${role} model ${selection.providerID}/${selection.modelID}; using fallback ${fallback.providerID}/${fallback.modelID}`);
    return fallback;
  }
  return { ...fallback, providerID: resolved.providerID, modelID: resolved.modelID, variant: "default" };
}
export async function clearAiRoleSelection(role: AiRole): Promise<void> { const value = await read(); delete value[role]; await write(value); }
export const AI_ROLE_LABELS: Record<AiRole, string> = { coding: "💻 Coding AI", image: "🎨 Image AI", video: "🎬 Video AI", stt: "🎙️ Speech-to-Text" };
