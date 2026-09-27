import { createHash } from "node:crypto";
import { deleteCustomProvider, listCustomProviders } from "./custom-provider-service.js";
import { deleteMcpServer } from "./mcp-server-service.js";
import { listManagedMcpServers } from "./mcp-server-store.js";
import { deleteGlobalSkill, isManagedSkillLocation } from "./skill-manage-service.js";
import { loadSkillsCatalog } from "./skills-catalog-service.js";
import { getTailscaleRuntimeStatus, removeTailscaleIntegration } from "./tailscale-integration-service.js";
import { listStoredExtensions, getStoredExtension, removeStoredExtension } from "./extension-store.js";
import { removeExtensionCredentials } from "./credential-vault-service.js";
import { removeGeneratedActionsForExtension } from "./generated-action-store.js";
import type { ExtensionRecord, ExtensionSummary } from "../types/extension.js";

function safePart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80) || "extension";
}

function normalizeDirectory(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/u, "");
}

function scopeHash(projectDirectory: string): string {
  return createHash("sha256").update(normalizeDirectory(projectDirectory)).digest("hex").slice(0, 10);
}

export function extensionId(kind: ExtensionRecord["kind"], name: string, projectDirectory?: string): string {
  const base = `${kind}:${safePart(name)}`;
  if ((kind === "mcp" || kind === "integration") && projectDirectory?.trim()) {
    return `${base}:${scopeHash(projectDirectory)}`;
  }
  return base;
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
  const normalizedDirectory = normalizeDirectory(projectDirectory);
  const stored = (await listStoredExtensions()).filter((record) =>
    record.resource.kind !== "mcp" || normalizeDirectory(record.resource.projectDirectory) === normalizedDirectory
  );
  const claimedMcpNames = new Set(
    stored
      .filter((record) => record.resource.kind === "mcp")
      .map((record) => record.resource.kind === "mcp" ? record.resource.serverName : ""),
  );
  const claimedSkills = new Set(
    stored
      .filter((record) => record.resource.kind === "skill")
      .map((record) => record.resource.kind === "skill" ? record.resource.skillName : ""),
  );
  const claimedProviders = new Set(
    stored
      .filter((record) => record.resource.kind === "model-provider")
      .map((record) => record.resource.kind === "model-provider" ? record.resource.providerId : ""),
  );

  const [mcps, skills, providers, tailscale] = await Promise.all([
    listManagedMcpServers(projectDirectory),
    loadSkillsCatalog(projectDirectory).catch(() => []),
    listCustomProviders(),
    getTailscaleRuntimeStatus().catch(() => null),
  ]);

  const discovered: ExtensionSummary[] = [
    ...mcps
      .filter((item) => !claimedMcpNames.has(item.name))
      .map((item) => ({
        id: extensionId("mcp", item.name, projectDirectory),
        name: item.name,
        kind: "mcp" as const,
        source: item.config.type === "remote" ? item.config.url : item.config.command.join(" "),
        authType: "none" as const,
        status: "ready" as const,
        managed: true,
      })),
    ...skills
      .filter((item) => isManagedSkillLocation(item.location) && !claimedSkills.has(item.name))
      .map((item) => ({
        id: extensionId("skill", item.name),
        name: item.name,
        kind: "skill" as const,
        source: item.developer ?? item.location ?? "managed skill",
        authType: "none" as const,
        status: "ready" as const,
        managed: true,
      })),
    ...providers
      .filter((item) => !claimedProviders.has(item.id))
      .map((item) => ({
        id: extensionId("model-provider", item.id),
        name: item.name,
        kind: "model-provider" as const,
        source: item.baseURL,
        authType: "api-key" as const,
        status: "ready" as const,
        managed: true,
      })),
  ];

  if (tailscale?.configured && !stored.some((item) => item.id === "integration:tailscale")) {
    discovered.push({
      id: "integration:tailscale",
      name: "Tailscale",
      kind: "integration",
      source: "tailscale",
      authType: "api-key",
      status: tailscale.connected ? "ready" : "unknown",
      managed: true,
    });
  }

  const byId = new Map<string, ExtensionSummary>();
  for (const item of [...stored.map(summaryFromStored), ...discovered]) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function getExtensionInfo(projectDirectory: string, id: string): Promise<ExtensionSummary | null> {
  return (await listExtensions(projectDirectory)).find((item) => item.id === id) ?? null;
}

export async function removeExtension(projectDirectory: string, id: string): Promise<{
  removed: boolean;
  credentialsRemoved: number;
  actionsRemoved: number;
}> {
  const stored = await getStoredExtension(id);
  let removed = false;

  if (stored?.resource.kind === "mcp") {
    removed = (await deleteMcpServer(stored.resource.projectDirectory, stored.resource.serverName)).deleted;
  } else if (stored?.resource.kind === "skill") {
    removed = await deleteGlobalSkill(stored.resource.skillName);
  } else if (stored?.resource.kind === "model-provider") {
    removed = await deleteCustomProvider(stored.resource.providerId);
  } else if (stored?.resource.kind === "integration" && stored.resource.adapter === "tailscale") {
    await removeTailscaleIntegration();
    removed = true;
  } else if (id.startsWith("mcp:")) {
    const info = await getExtensionInfo(projectDirectory, id);
    removed = info ? (await deleteMcpServer(projectDirectory, info.name)).deleted : false;
  } else if (id.startsWith("skill:")) {
    const info = await getExtensionInfo(projectDirectory, id);
    removed = info ? await deleteGlobalSkill(info.name) : false;
  } else if (id.startsWith("model-provider:")) {
    const info = await getExtensionInfo(projectDirectory, id);
    if (info) {
      const provider = (await listCustomProviders()).find((item) => item.name === info.name || extensionId("model-provider", item.id) === id);
      removed = provider ? await deleteCustomProvider(provider.id) : false;
    }
  } else if (id === "integration:tailscale") {
    await removeTailscaleIntegration();
    removed = true;
  }

  const [credentialsRemoved, actionsRemoved] = await Promise.all([
    removeExtensionCredentials(id),
    removeGeneratedActionsForExtension(id),
  ]);
  if (stored) await removeStoredExtension(id);
  return { removed: removed || Boolean(stored), credentialsRemoved, actionsRemoved };
}
