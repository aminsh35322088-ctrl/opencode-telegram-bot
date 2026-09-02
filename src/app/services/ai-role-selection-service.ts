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

const FILE = "ai-role-selection.json";
const AI_ROLES: readonly AiRole[] = ["coding", "image", "video", "stt"];

function filePath(): string {
  return path.join(getRuntimePaths().appHome, FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isValidRoleModel(value: unknown): value is { providerID: string; modelID: string } {
  return (
    isRecord(value) &&
    typeof value.providerID === "string" &&
    value.providerID.trim().length > 0 &&
    typeof value.modelID === "string" &&
    value.modelID.trim().length > 0
  );
}

function isRoleSelection(value: unknown): value is AiRoleSelection {
  if (!isRecord(value)) return false;
  return Object.keys(value).every(
    (key) => AI_ROLES.includes(key as AiRole) && isValidRoleModel(value[key]),
  );
}

function normalizeRoleSelection(value: unknown): AiRoleSelection {
  if (!isRecord(value)) return {};

  const selections: AiRoleSelection = {};
  for (const role of AI_ROLES) {
    const candidate = value[role];
    if (!isValidRoleModel(candidate)) continue;
    selections[role] = {
      providerID: candidate.providerID.trim(),
      modelID: candidate.modelID.trim(),
    };
  }
  return selections;
}

function firstLegacyChatSelection(chats: unknown): AiRoleSelection | undefined {
  if (!isRecord(chats)) return undefined;

  for (const entry of Object.values(chats)) {
    const selection = normalizeRoleSelection(entry);
    if (Object.keys(selection).length > 0) return selection;
  }

  return undefined;
}

function normalizeStored(value: unknown): { stored: StoredRoleSelections; migrated: boolean } {
  if (isRecord(value) && value.version === 2 && isRoleSelection(value.selections)) {
    return {
      stored: {
        version: 2,
        selections: normalizeRoleSelection(value.selections),
      },
      migrated: false,
    };
  }

  if (isRecord(value) && value.version === 1) {
    // v1 was the temporary multi-chat format. The single-user architecture is
    // deployment-wide, so prefer its legacy/global selection and only fall back
    // to the first preserved chat selection when no global selection exists.
    const legacy = normalizeRoleSelection(value.legacy);
    const fromChat = firstLegacyChatSelection(value.chats);
    const selections = Object.keys(legacy).length > 0 ? legacy : fromChat ?? {};

    return {
      stored: { version: 2, selections },
      migrated: true,
    };
  }

  // The original/global format was the role-selection object itself.
  if (isRoleSelection(value)) {
    return {
      stored: { version: 2, selections: normalizeRoleSelection(value) },
      migrated: false,
    };
  }

  return {
    stored: { version: 2, selections: {} },
    migrated: false,
  };
}

async function read(): Promise<StoredRoleSelections> {
  try {
    const value = JSON.parse(await fs.readFile(filePath(), "utf8")) as unknown;
    const result = normalizeStored(value);

    if (result.migrated) {
      logger.info(
        "[AI Rules] Loaded legacy v1 AI Rules and migrated them to the deployment-wide singleton model.",
      );
    }

    return result.stored;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 2, selections: {} };
    }
    throw error;
  }
}

async function write(value: StoredRoleSelections): Promise<void> {
  await fs.mkdir(path.dirname(filePath()), { recursive: true });
  const temp = `${filePath()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temp, filePath());
}

export async function getAiRoleSelections(): Promise<AiRoleSelection> {
  const value = await read();
  return { ...value.selections };
}

export async function getAiRoleSelection(
  role: AiRole,
): Promise<{ providerID: string; modelID: string } | undefined> {
  const value = await getAiRoleSelections();
  return value[role];
}

export async function setAiRoleSelection(
  role: AiRole,
  providerID: string,
  modelID: string,
): Promise<void> {
  const normalizedProviderID = providerID.trim();
  const normalizedModelID = modelID.trim();
  if (!normalizedProviderID || !normalizedModelID) {
    throw new Error("AI role selection requires a provider and model.");
  }

  const value = await read();
  value.selections = {
    ...value.selections,
    [role]: {
      providerID: normalizedProviderID,
      modelID: normalizedModelID,
    },
  };
  await write(value);
}

export async function getModelForRole(
  role: AiRole,
  fallback: ModelInfo,
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

export async function clearAiRoleSelection(role: AiRole): Promise<void> {
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
