import { createHash } from "node:crypto";

export type CatalogRecord = Record<string, unknown>;
export interface ProviderCatalog { records: CatalogRecord[]; fetchedAt: number; }
const TTL_MS = 5 * 60_000;
const MAX_CATALOGS = 32;
const catalogs = new Map<string, ProviderCatalog>();
const pending = new Map<string, Promise<ProviderCatalog>>();
const failures = new Map<string, number>();

function catalogKey(baseURL: string, apiKey: string): string {
  return createHash("sha256").update(JSON.stringify([baseURL.replace(/\/$/, ""), apiKey.trim()])).digest("hex");
}
export function peekProviderCatalog(baseURL: string, apiKey: string): ProviderCatalog | undefined {
  return catalogs.get(catalogKey(baseURL, apiKey));
}

/** Shared discovery/refresh cache. No timer, credential persistence or inference. */
export async function fetchProviderCatalog(baseURL: string, apiKey: string): Promise<ProviderCatalog> {
  const key = catalogKey(baseURL, apiKey);
  const cached = catalogs.get(key);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached;
  const active = pending.get(key);
  if (active) return active;
  if (Date.now() - (failures.get(key) ?? -Infinity) < 30_000) {
    if (cached) return cached;
    throw new Error("Provider catalog refresh is cooling down after a failure");
  }
  const request = (async () => {
    const response = await fetch(baseURL.replace(/\/$/, "") + "/models", {
      headers: { Authorization: "Bearer " + apiKey.trim() }, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("Model discovery failed: HTTP " + response.status);
    const payload: unknown = await response.json();
    const data = payload && typeof payload === "object" && "data" in payload ? payload.data : undefined;
    if (!Array.isArray(data)) throw new Error("Provider returned an invalid /models catalog");
    const records = data.filter((record): record is CatalogRecord => !!record && typeof record === "object" && !Array.isArray(record) && typeof record.id === "string" && !!record.id.trim());
    if (!records.length) throw new Error("Provider returned no models from /models");
    const catalog = { records, fetchedAt: Date.now() };
    failures.delete(key);
    catalogs.delete(key);
    catalogs.set(key, catalog);
    while (catalogs.size > MAX_CATALOGS) catalogs.delete(catalogs.keys().next().value!);
    return catalog;
  })();
  pending.set(key, request);
  try { return await request; }
  catch (error) {
    failures.set(key, Date.now());
    while (failures.size > MAX_CATALOGS) failures.delete(failures.keys().next().value!);
    throw error;
  } finally { if (pending.get(key) === request) pending.delete(key); }
}
export function __resetProviderCatalogForTests(): void { catalogs.clear(); pending.clear(); failures.clear(); }
