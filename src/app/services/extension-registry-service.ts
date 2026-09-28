import { reloadManagedOpenCodeConfig } from "./opencode-managed-config-service.js";
import { deleteGlobalSkill, isManagedSkillLocation } from "./skill-manage-service.js";
import { loadSkillsCatalog } from "./skills-catalog-service.js";
import {
  getStoredExtension,
  listStoredExtensions,
  removeStoredExtension,
  saveStoredExtension,
} from "./extension-store.js";
import { removeExtensionCredentials } from "./credential-vault-service.js";
import { removeGeneratedActionsForExtension } from "./generated-action-store.js";
import type { ExtensionRecord, ExtensionSummary } from "../types/extension.js";

function safePart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80) || "extension";
}

export function extensionId(kind: "skill" | "plugin", name: string): string {
  return `${kind}:${safePart(name)}`;
}

function summaryFromStored(record: ExtensionRecord): ExtensionSummary {
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    source: record.source,
    authType: record.authType,
    status: "ready",
    managed: record.managed,
  };
}

export async function listExtensions(projectDirectory: string): Promise<ExtensionSummary[]> {
  const stored = (await listStoredExtensions()).filter(
    (record) => record.kind === "skill" || record.kind === "plugin",
  );
  const claimedSkills = new Set(
    stored
      .filter((record) => record.resource.kind === "skill")
      .map((record) => record.resource.kind === "skill" ? record.resource.skillName : ""),
  );

  const skills = await loadSkillsCatalog(projectDirectory).catch(() => []);
  const discoveredSkills: ExtensionSummary[] = skills
    .filter((item) => isManagedSkillLocation(item.location) && !claimedSkills.has(item.name))
    .map((item) => ({
      id: extensionId("skill", item.name),
      name: item.name,
      kind: "skill",
      source: item.developer ?? item.location ?? "managed skill",
      authType: "none",
      status: "ready",
      managed: true,
    }));

  const byId = new Map<string, ExtensionSummary>();
  for (const item of [...stored.map(summaryFromStored), ...discoveredSkills]) {
    byId.set(item.id, item);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function getExtensionInfo(
  projectDirectory: string,
  id: string,
): Promise<ExtensionSummary | null> {
  return (await listExtensions(projectDirectory)).find((item) => item.id === id) ?? null;
}

export async function removeExtension(
  projectDirectory: string,
  id: string,
): Promise<{ removed: boolean; credentialsRemoved: number; actionsRemoved: number }> {
  const stored = await getStoredExtension(id);

  if (stored?.resource.kind === "plugin") {
    await removeStoredExtension(id);
    try {
      await reloadManagedOpenCodeConfig("extension_plugin_remove", { timeoutMs: 30_000 });
    } catch (error) {
      await saveStoredExtension(stored);
      await reloadManagedOpenCodeConfig(
        "extension_plugin_remove_rollback",
        { timeoutMs: 30_000 },
      ).catch(() => {});
      throw error;
    }
  } else if (stored?.resource.kind === "skill") {
    await deleteGlobalSkill(stored.resource.skillName);
    await removeStoredExtension(id);
  } else if (id.startsWith("skill:")) {
    const info = await getExtensionInfo(projectDirectory, id);
    if (info) await deleteGlobalSkill(info.name);
  } else {
    return { removed: false, credentialsRemoved: 0, actionsRemoved: 0 };
  }

  const [credentialsRemoved, actionsRemoved] = await Promise.all([
    removeExtensionCredentials(id),
    removeGeneratedActionsForExtension(id),
  ]);
  return { removed: true, credentialsRemoved, actionsRemoved };
}
