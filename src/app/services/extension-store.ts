import { readAppState, updateAppState } from "../stores/app-state-store.js";
import { isRecord } from "../../utils/type-guards.js";
import { EXTENSION_AUTH_TYPES, EXTENSION_KINDS, type ExtensionRecord } from "../types/extension.js";

interface ExtensionStoreState {
  version: 1;
  records: Record<string, ExtensionRecord>;
}

const STORE_KEY = "extensions";
const CREDENTIAL_TYPES = new Set(["api-key", "bearer"]);
const CREDENTIAL_TRANSPORTS = new Set(["authorization-bearer", "api-key-header", "provider-api-key"]);

function normalizeCredentialSchemas(value: unknown): ExtensionRecord["credentialSchemas"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.label !== "string" ||
      typeof item.type !== "string" ||
      !CREDENTIAL_TYPES.has(item.type) ||
      !isRecord(item.transport) ||
      typeof item.transport.kind !== "string" ||
      !CREDENTIAL_TRANSPORTS.has(item.transport.kind)
    ) return [];
    return [{
      id: item.id.trim(),
      label: item.label.trim(),
      type: item.type as "api-key" | "bearer",
      transport: { kind: item.transport.kind as "authorization-bearer" | "api-key-header" | "provider-api-key" },
    }];
  }).filter((item) => item.id && item.label);
}

function normalizeResource(value: unknown): ExtensionRecord["resource"] | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "mcp" && typeof value.serverName === "string" && typeof value.projectDirectory === "string") {
    const serverName = value.serverName.trim();
    const projectDirectory = value.projectDirectory.trim();
    return serverName && projectDirectory ? { kind: "mcp", serverName, projectDirectory } : null;
  }
  if (value.kind === "skill" && typeof value.skillName === "string" && value.skillName.trim()) {
    return { kind: "skill", skillName: value.skillName.trim() };
  }
  if (value.kind === "model-provider" && typeof value.providerId === "string" && value.providerId.trim()) {
    return { kind: "model-provider", providerId: value.providerId.trim() };
  }
  if (value.kind === "plugin" && typeof value.specifier === "string" && value.specifier.trim()) {
    return { kind: "plugin", specifier: value.specifier.trim() };
  }
  if (value.kind === "integration" && typeof value.adapter === "string" && value.adapter.trim()) {
    return { kind: "integration", adapter: value.adapter.trim() };
  }
  return null;
}

function normalizeRecord(value: unknown): ExtensionRecord | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.kind !== "string" ||
    !EXTENSION_KINDS.includes(value.kind as never) ||
    typeof value.source !== "string" ||
    typeof value.authType !== "string" ||
    !EXTENSION_AUTH_TYPES.includes(value.authType as never) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    typeof value.managed !== "boolean" ||
    !isRecord(value.resource)
  ) return null;
  const resource = normalizeResource(value.resource);
  if (!resource) return null;
  return {
    id: value.id.trim(),
    name: value.name.trim(),
    kind: value.kind as ExtensionRecord["kind"],
    source: value.source.trim(),
    ...(typeof value.purpose === "string" && value.purpose.trim() ? { purpose: value.purpose.trim() } : {}),
    authType: value.authType as ExtensionRecord["authType"],
    credentialSchemas: normalizeCredentialSchemas(value.credentialSchemas),
    resource,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    managed: value.managed,
  };
}

function parseState(value: unknown): ExtensionStoreState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.records)) return { version: 1, records: {} };
  const records: Record<string, ExtensionRecord> = {};
  for (const [id, valueRecord] of Object.entries(value.records)) {
    const record = normalizeRecord(valueRecord);
    if (record && record.id === id) records[id] = record;
  }
  return { version: 1, records };
}

export async function listStoredExtensions(): Promise<ExtensionRecord[]> {
  const state = await readAppState();
  return Object.values(parseState(state[STORE_KEY]).records).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getStoredExtension(id: string): Promise<ExtensionRecord | null> {
  const state = await readAppState();
  return parseState(state[STORE_KEY]).records[id] ?? null;
}

export async function saveStoredExtension(record: ExtensionRecord): Promise<void> {
  if (!record.id.trim() || !record.name.trim()) throw new Error("Extension id and name are required.");
  await updateAppState((state) => {
    const current = parseState(state[STORE_KEY]);
    return { [STORE_KEY]: { version: 1, records: { ...current.records, [record.id]: record } } };
  });
}

export async function removeStoredExtension(id: string): Promise<boolean> {
  let removed = false;
  await updateAppState((state) => {
    const current = parseState(state[STORE_KEY]);
    if (!current.records[id]) return { [STORE_KEY]: current };
    const records = { ...current.records };
    delete records[id];
    removed = true;
    return { [STORE_KEY]: { version: 1, records } };
  });
  return removed;
}
