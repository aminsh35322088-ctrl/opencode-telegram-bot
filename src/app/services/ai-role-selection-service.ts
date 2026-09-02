import fs from "node:fs/promises";
import path from "node:path";
import type { ModelInfo } from "../types/model.js";
import { getRuntimePaths } from "../../runtime/paths.js";
import { resolveCatalogModel } from "./model-selection-service.js";
import { logger } from "../../utils/logger.js";

export type AiRole = "coding" | "image" | "video" | "stt";
export interface AiRoleSelection {
  coding?: { providerID: string; modelID: string };
  image?: { providerID: string; modelID: string };
  video?: { providerID: string; modelID: string };
  stt?: { providerID: string; modelID: string };
}

interface StoredRoleSelections {
  version: 2;
  selections: AiRoleSelection;
}

interface LegacyStoredRoleSelections {
  version: 1;
  legacy?: AiRoleSelection;
  chats?: Record<string, AiRoleSelection>;
}

const FILE = "ai-role-selection.json";

function filePath(): string {
  return path.join(getRuntimePaths().appHome, FILE);
}

async function readRaw(): Promise<AiRoleSelection | StoredRoleSelections | LegacyStoredRoleSelections> {
  try {
    const value = JSON.parse(await fs.readFile(filePath(), "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function isRoleSelection(value: unknown): value is AiRoleSelection {
  return typeof value === "object" && value !== null;
}

function normalizeStored(value: AiRoleSelection | StoredRoleSelections | LegacyStoredRoleSelections): StoredRoleSelections {
  if ("version" in value && value.version === 2 && "selections" in value && isRoleSelection(value.selections)) {
    return { version: 2, selections: value.selections };
  }

  if ("version" in value && value.version === 1) {
    // Migrate legacy multi-chat state into the single deployment-wide selection.
    // Prefer the legacy/global selection; otherwise preserve the first available
    // chat selection so an existing installation keeps working after upgrade.
    if (isRoleSelection(value.legacy)) return { version: 2, selections: value.legacy };
    const chats = value.chats;
    if (chats && typeof chats === "object") {
      const first = Object.values(chats).find(isRoleSelection);
      if (first) return { version: 2, selections: first };
    }
    return { version: 2, selections: {} };
  }

  return { version: 2, selections: value as AiRoleSelection };
}

async function read(): Promise<StoredRoleSelections> {
  return normalizeStored(await readRaw());
}

async function write(value: StoredRoleSelections): Promise<void> {
  await fs.mkdir(path.dirname(filePath()), { recursive: true });
  const temp = `${filePath()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temp, filePath());
}

export async function getAiRoleSelections(_chatId?: number): Promise<AiRoleSelection> {
  const value = await read();
  return { ...value.selections };
}

export async function getAiRoleSelection(
  role: AiRole,
  _chatId?: number,
): Promise<{ providerID: string; modelID: string } | undefined> {
  const value = await getAiRoleSelections();
  return value[role];
}

export async function setAiRoleSelection(
  role: AiRole,
  providerID: string,
  modelID: string,
  _chatId?: number,
): Promise<void> {
  const normalizedProviderID = providerID.trim();
  const normalizedModelID = modelID.trim();
  if (!normalizedProviderID || !normalizedModelID) {
    throw new Error("AI role selection requires a provider and model.");
  }

  const value = await read();
  value.selections = {
    ...value.selections,
    [role]: { providerID: normalizedProviderID, modelID: normalizedModelID },
  };
  await write(value);
}

export async function getModelForRole(
  role: AiRole,
  fallback: ModelInfo,
  _chatId?: number,
): Promise<ModelInfo> {
  const selection = await getAiRoleSelection(role);
  if (!selection?.providerID?.trim() || !selection.modelID.trim()) return fallback;

  const resolved = await resolveCatalogModel(selection.providerID, selection.modelID);
  if (!resolved) {
    logger.warn(
      `[AI Rules] Ignoring unavailable ${role} model ${selection.providerID}/${selection.modelID}; using fallback ${fallback.providerID}/${fallback.modelID}`,
    );
    return fallback;
  }

  return {
    ...fallback,
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    variant: "default",
  };
}

export async function clearAiRoleSelection(role: AiRole, _chatId?: number): Promise<void> {
  const value = await read();
  const selections = { ...value.selections };
  delete selections[role];
  value.selections = selections;
  await write(value);
}

export const AI_ROLE_LABELS: Record<AiRole, string> = {
  coding: "💻 Coding AI",
  image: "🎨 Image AI",
  video: "🎬 Video AI",
  stt: "🎙️ Speech-to-Text",
};
