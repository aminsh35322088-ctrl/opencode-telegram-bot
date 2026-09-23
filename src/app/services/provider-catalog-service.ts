import { createHash } from "node:crypto";

export type CatalogRecord = Record<string, unknown>;
export interface ProviderCatalog { records: CatalogRecord[]; fetchedAt: number; }
export interface ProviderCatalogFetchOptions { force?: boolean; }

const TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_ATTEMPTS = 2;
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

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function getTransportErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const directCode = (error as NodeJS.ErrnoException).code;
  if (typeof directCode === "string" && directCode) return directCode;

  const cause = error.cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    const causeCode = (cause as { code?: unknown }).code;
    if (typeof causeCode === "string" && causeCode) return causeCode;
  }
  return undefined;
}

function isRetryableTransportError(error: unknown): boolean {
  return isTimeoutError(error) || error instanceof TypeError;
}

async function fetchCatalogResponse(baseURL: string, apiKey: string): Promise<Response> {
  for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt += 1) {
    try {
      return await fetch(baseURL.replace(/\/$/, "") + "/models", {
        headers: { Authorization: "Bearer " + apiKey.trim() },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (!isRetryableTransportError(error)) throw error;
      if (attempt === REQUEST_ATTEMPTS) {
        if (isTimeoutError(error)) {
          throw new Error(
            `Model discovery timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds (${REQUEST_ATTEMPTS} attempts)`,
          );
        }

        const code = getTransportErrorCode(error) ?? "NETWORK_ERROR";
        throw new Error(`Model discovery connection failed (${code}) after ${REQUEST_ATTEMPTS} attempts`);
      }
    }
  }

  throw new Error("Model discovery failed before receiving a response");
}

/** Shared discovery/refresh cache. No timer, credential persistence or inference. */
export async function fetchProviderCatalog(
  baseURL: string,
  apiKey: string,
  options: ProviderCatalogFetchOptions = {},
): Promise<ProviderCatalog> {
  const key = catalogKey(baseURL, apiKey);
  const cached = catalogs.get(key);
  const force = options.force === true;

  if (!force && cached && Date.now() - cached.fetchedAt < TTL_MS) return cached;

  // Always share an already-running request. A forced refresh bypasses stale
  // cache/cooldown, but it must not create duplicate /models traffic.
  const active = pending.get(key);
  if (active) return active;

  if (!force && Date.now() - (failures.get(key) ?? -Infinity) < 30_000) {
    if (cached) return cached;
    throw new Error("Provider catalog refresh is cooling down after a failure");
  }

  const request = (async () => {
    const response = await fetchCatalogResponse(baseURL, apiKey);
    if (!response.ok) throw new Error("Model discovery failed: HTTP " + response.status);

    const payload: unknown = await response.json();
    const data = payload && typeof payload === "object" && "data" in payload ? payload.data : undefined;
    if (!Array.isArray(data)) throw new Error("Provider returned an invalid /models catalog");

    const records = data.filter((record): record is CatalogRecord =>
      !!record &&
      typeof record === "object" &&
      !Array.isArray(record) &&
      typeof record.id === "string" &&
      !!record.id.trim()
    );
    if (!records.length) throw new Error("Provider returned no models from /models");

    const catalog = { records, fetchedAt: Date.now() };
    failures.delete(key);
    catalogs.delete(key);
    catalogs.set(key, catalog);
    while (catalogs.size > MAX_CATALOGS) catalogs.delete(catalogs.keys().next().value!);
    return catalog;
  })();

  pending.set(key, request);
  try {
    return await request;
  } catch (error) {
    failures.set(key, Date.now());
    while (failures.size > MAX_CATALOGS) failures.delete(failures.keys().next().value!);
    throw error;
  } finally {
    if (pending.get(key) === request) pending.delete(key);
  }
}

export function __resetProviderCatalogForTests(): void {
  catalogs.clear();
  pending.clear();
  failures.clear();
}
