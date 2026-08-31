import fs from "node:fs/promises";
import path from "node:path";
import type { ModelInfo } from "../types/model.js";
import { getRuntimePaths } from "../../runtime/paths.js";
import { resolveCatalogModel } from "./model-selection-service.js";
import { logger } from "../../utils/logger.js";

export type AiRole = "coding" | "image" | "video" | "stt";
export interface AiRoleSelection { coding?: { providerID: string; modelID: string }; image?: { providerID: string; modelID: string }; video?: { providerID: string; modelID: string }; stt?: { providerID: string; modelID: string }; }
interface StoredRoleSelections { version: 1; legacy?: AiRoleSelection; chats: Record<string, AiRoleSelection>; }
const FILE = "ai-role-selection.json";
function filePath(): string { return path.join(getRuntimePaths().appHome, FILE); }
async function readRaw(): Promise<AiRoleSelection | StoredRoleSelections> { try { const value = JSON.parse(await fs.readFile(filePath(), "utf8")); return value && typeof value === "object" ? value : {}; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; } }
function normalizeStored(value: AiRoleSelection | StoredRoleSelections): StoredRoleSelections { if ("version" in value && value.version === 1 && value.chats && typeof value.chats === "object") return value as StoredRoleSelections; return { version: 1, legacy: value as AiRoleSelection, chats: {} }; }
async function read(): Promise<StoredRoleSelections> { return normalizeStored(await readRaw()); }
async function write(value: StoredRoleSelections): Promise<void> { await fs.mkdir(path.dirname(filePath()), { recursive: true }); const temp = `${filePath()}.tmp`; await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); await fs.rename(temp, filePath()); }
function chatKey(chatId: number | undefined): string | undefined { return chatId !== undefined && Number.isSafeInteger(chatId) ? String(chatId) : undefined; }
export async function getAiRoleSelections(chatId?: number): Promise<AiRoleSelection> { const value = await read(); const key = chatKey(chatId); return key ? (value.chats[key] ?? value.legacy ?? {}) : (value.legacy ?? {}); }
export async function getAiRoleSelection(role: AiRole, chatId?: number): Promise<{ providerID: string; modelID: string } | undefined> { const value = await getAiRoleSelections(chatId); return value[role]; }
export async function setAiRoleSelection(role: AiRole, providerID: string, modelID: string, chatId?: number): Promise<void> {
  const normalizedProviderID = providerID.trim(); const normalizedModelID = modelID.trim(); if (!normalizedProviderID || !normalizedModelID) throw new Error("AI role selection requires a provider and model.");
  const value = await read(); const key = chatKey(chatId); if (key) { value.chats[key] = { ...(value.chats[key] ?? value.legacy ?? {}), [role]: { providerID: normalizedProviderID, modelID: normalizedModelID } }; } else { value.legacy = { ...(value.legacy ?? {}), [role]: { providerID: normalizedProviderID, modelID: normalizedModelID } }; }
  await write(value);
}
export async function getModelForRole(role: AiRole, fallback: ModelInfo, chatId?: number): Promise<ModelInfo> {
  const selection = await getAiRoleSelection(role, chatId); if (!selection?.providerID?.trim() || !selection.modelID?.trim()) return fallback;
  const resolved = await resolveCatalogModel(selection.providerID, selection.modelID);
  if (!resolved) { logger.warn(`[AI Rules] Ignoring unavailable ${role} model ${selection.providerID}/${selection.modelID}; using fallback ${fallback.providerID}/${fallback.modelID}`); return fallback; }
  return { ...fallback, providerID: resolved.providerID, modelID: resolved.modelID, variant: "default" };
}
export async function clearAiRoleSelection(role: AiRole, chatId?: number): Promise<void> { const value = await read(); const key = chatKey(chatId); if (key) { const selections = { ...(value.chats[key] ?? {}) }; delete selections[role]; value.chats[key] = selections; } else { const selections = { ...(value.legacy ?? {}) }; delete selections[role]; value.legacy = selections; } await write(value); }
export const AI_ROLE_LABELS: Record<AiRole, string> = { coding: "💻 Coding AI", image: "🎨 Image AI", video: "🎬 Video AI", stt: "🎙️ Speech-to-Text" };
