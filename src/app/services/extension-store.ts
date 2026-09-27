import { readAppState, updateAppState } from "../stores/app-state-store.js";
import { isRecord } from "../../utils/type-guards.js";
import { EXTENSION_AUTH_TYPES, EXTENSION_KINDS, type ExtensionRecord } from "../types/extension.js";

interface ExtensionStoreState {
  version: 1;
  records: Record<string, ExtensionRecord>;
}

const STORE_KEY = "extensions";

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
  const schemas = Array.isArray(value.credentialSchemas)
    ? value.credentialSchemas.filter((item) => isRecord(item) && typeof item.id === "string" && typeof item.label === "string" && typeof item.type === "string" && isRecord(item.transport))
    : [];
  return {
    id: value.id.trim(),
    name: value.name.trim(),
    kind: value.kind as ExtensionRecord["kind"],
    source: value.source.trim(),
    ...(typeof value.purpose === "string" && value.purpose.trim() ? { purpose: value.purpose.trim() } : {}),
    authType: value.authType as ExtensionRecord["authType"],
    credentialSchemas: schemas as ExtensionRecord["credentialSchemas"],
    resource: value.resource as ExtensionRecord["resource"],
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
