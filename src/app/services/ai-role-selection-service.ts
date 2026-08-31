import fs from "node:fs/promises";
import path from "node:path";
import { getRuntimePaths } from "../../runtime/paths.js";

export type AiRole = "coding" | "image" | "video" | "stt";
export interface AiRoleSelection { coding?: { providerID: string; modelID: string }; image?: { providerID: string; modelID: string }; video?: { providerID: string; modelID: string }; stt?: { providerID: string; modelID: string }; }

const FILE = "ai-role-selection.json";
function filePath(): string { return path.join(getRuntimePaths().appHome, FILE); }
async function read(): Promise<AiRoleSelection> { try { const value = JSON.parse(await fs.readFile(filePath(), "utf8")) as AiRoleSelection; return value && typeof value === "object" ? value : {}; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; } }
async function write(value: AiRoleSelection): Promise<void> { await fs.mkdir(path.dirname(filePath()), { recursive: true }); const temp = `${filePath()}.tmp`; await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); await fs.rename(temp, filePath()); }
export async function getAiRoleSelections(): Promise<AiRoleSelection> { return read(); }
export async function getAiRoleSelection(role: AiRole): Promise<{ providerID: string; modelID: string } | undefined> { const value = await read(); return value[role]; }
export async function setAiRoleSelection(role: AiRole, providerID: string, modelID: string): Promise<void> { const value = await read(); value[role] = { providerID, modelID }; await write(value); }
export async function clearAiRoleSelection(role: AiRole): Promise<void> { const value = await read(); delete value[role]; await write(value); }
export const AI_ROLE_LABELS: Record<AiRole, string> = { coding: "💻 Coding AI", image: "🎨 Image AI", video: "🎬 Video AI", stt: "🎙️ Speech-to-Text" };
