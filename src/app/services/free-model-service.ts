import { getCustomProviderConfig, type CustomProviderModel } from "./custom-provider-service.js";
import { logger } from "../../utils/logger.js";

export type FreeModelConfidence = "high" | "low" | "none";
export type FreeModelStatus = "free" | "paid" | "unknown";
export type FreeModelAvailability = "available" | "untested" | "unavailable";

export interface FreeModelInfo extends CustomProviderModel {
  providerID: string;
  status: FreeModelStatus;
  confidence: FreeModelConfidence;
  availability: FreeModelAvailability;
  reason: string;
}

interface Pricing {
  prompt?: number;
  completion?: number;
  request?: number;
  image?: number;
  inputCacheRead?: number;
  inputCacheWrite?: number;
}

interface ModelRecord {
  id?: unknown;
  name?: unknown;
  pricing?: unknown;
  free?: unknown;
  is_free?: unknown;
  metadata?: unknown;
}

interface ScanCache { expiresAt: number; models: FreeModelInfo[]; }
interface AvailabilityCacheEntry { expiresAt: number; availability: Exclude<FreeModelAvailability, "untested">; }

const CACHE_TTL_MS = 2 * 60 * 1000;
const AVAILABILITY_CACHE_TTL_MS = 2 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const AVAILABILITY_CONCURRENCY = 16;
let cache: ScanCache | null = null;
let inFlight: Promise<FreeModelInfo[]> | null = null;
const availabilityCache = new Map<string, AvailabilityCacheEntry>();
const providerConfigPromises = new Map<string, ReturnType<typeof getCustomProviderConfig>>();

function normalizeBaseURL(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Base URL must use http:// or https://");
  return url.toString().replace(/\/$/, "");
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function extractPricing(value: unknown): Pricing | undefined {
  const candidates = Array.isArray(value) ? value : [value];
  const pricing: Pricing = {};
  let found = false;
  const aliases: Array<[keyof Pricing, string[]]> = [
    ["prompt", ["prompt", "input"]],
    ["completion", ["completion", "output"]],
    ["request", ["request"]],
    ["image", ["image"]],
    ["inputCacheRead", ["input_cache_read", "cache_read"]],
    ["inputCacheWrite", ["input_cache_write", "cache_write"]],
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    for (const [field, names] of aliases) {
      for (const name of names) {
        const value = numericValue(record[name]);
        if (value !== undefined) {
          pricing[field] = Math.max(pricing[field] ?? 0, value);
          found = true;
          break;
        }
      }
    }
  }
  return found ? pricing : undefined;
}

function readExplicitFree(record: ModelRecord): boolean | undefined {
  const direct = booleanValue(record.free ?? record.is_free);
  if (direct !== undefined) return direct;
  if (record.metadata && typeof record.metadata === "object") {
    const metadata = record.metadata as Record<string, unknown>;
    return booleanValue(metadata.free ?? metadata.is_free);
  }
  return undefined;
}

function hasPositivePricing(pricing: Pricing): boolean { return Object.values(pricing).some((value) => typeof value === "number" && value > 0); }
function hasCompleteZeroPricing(pricing: Pricing): boolean {
  const values = Object.values(pricing).filter((value): value is number => typeof value === "number");
  return values.length >= 2 && values.every((value) => value === 0);
}

function classify(record: ModelRecord): Omit<FreeModelInfo, "providerID" | "availability"> | null {
  if (typeof record.id !== "string" || !record.id.trim()) return null;
  const id = record.id.trim();
  const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : id;
  const pricing = extractPricing(record.pricing);
  const explicitFree = readExplicitFree(record);
  if (explicitFree === true && pricing && hasPositivePricing(pricing)) return { id, name, status: "unknown", confidence: "none", reason: "Free metadata conflicts with non-zero pricing.", ...(pricing ? { pricing } : {}) };
  if (explicitFree === false && pricing && hasCompleteZeroPricing(pricing)) return { id, name, status: "unknown", confidence: "none", reason: "Non-free metadata conflicts with zero pricing.", ...(pricing ? { pricing } : {}) };
  if (explicitFree === true) return { id, name, status: "free", confidence: "high", reason: "Provider metadata explicitly marks this model as free.", ...(pricing ? { pricing } : {}) };
  if (pricing && hasPositivePricing(pricing)) return { id, name, status: "paid", confidence: "high", reason: "Provider metadata contains a non-zero model price.", ...(pricing ? { pricing } : {}) };
  if (explicitFree === false) return { id, name, status: "paid", confidence: "high", reason: "Provider metadata explicitly marks this model as not free.", ...(pricing ? { pricing } : {}) };
  if (pricing && hasCompleteZeroPricing(pricing)) return { id, name, status: "free", confidence: "high", reason: "Provider pricing reports zero cost for all advertised billable fields.", ...(pricing ? { pricing } : {}) };
  if (/:free$/i.test(id)) return { id, name, status: "free", confidence: "high", reason: "Model ID uses the explicit :free variant convention.", ...(pricing ? { pricing } : {}) };
  if (/\bfree\b/i.test(name) || /\bfree\b/i.test(id)) return { id, name, status: "free", confidence: "low", reason: "Model name or ID contains a free marker without authoritative pricing metadata.", ...(pricing ? { pricing } : {}) };
  return { id, name, status: "unknown", confidence: "none", reason: "Provider did not expose enough information to classify this model safely.", ...(pricing ? { pricing } : {}) };
}

async function scanProvider(providerID: string): Promise<FreeModelInfo[]> {
  const config = await getCustomProviderConfig(providerID);
  if (!config) return [];
  const baseURL = normalizeBaseURL(config.apiUrl);
  const response = await fetch(`${baseURL}/models`, { headers: { Authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Free-model scan failed for ${providerID}: HTTP ${response.status}`);
  const payload = (await response.json()) as { data?: unknown };
  if (!Array.isArray(payload.data)) return [];
  return payload.data.filter((item): item is ModelRecord => Boolean(item) && typeof item === "object").map(classify).filter((model): model is Omit<FreeModelInfo, "providerID" | "availability"> => Boolean(model)).map((model) => ({ ...model, providerID, availability: "untested" as const }));
}

async function scanAllProviders(): Promise<FreeModelInfo[]> {
  const providers = await import("./custom-provider-service.js").then(({ listCustomProviders }) => listCustomProviders());
  const settled = await Promise.allSettled(providers.map((provider) => scanProvider(provider.id)));
  const results: FreeModelInfo[] = [];
  settled.forEach((result, index) => {
    const providerID = providers[index]?.id ?? "unknown";
    if (result.status === "fulfilled") results.push(...result.value);
    else logger.warn(`[FreeModelScan] Provider ${providerID} failed; continuing with other providers.`, result.reason);
  });
  return results.filter((model) => model.status === "free" && model.confidence === "high").sort((a, b) => a.providerID.localeCompare(b.providerID) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export async function listVerifiedFreeModels(options?: { force?: boolean }): Promise<FreeModelInfo[]> {
  if (!options?.force && cache && Date.now() < cache.expiresAt) return cache.models;
  if (inFlight) return inFlight;
  inFlight = scanAllProviders().then((models) => { cache = { expiresAt: Date.now() + CACHE_TTL_MS, models }; return models; }).finally(() => { inFlight = null; });
  return inFlight;
}

async function getCachedProviderConfig(providerID: string): Promise<Awaited<ReturnType<typeof getCustomProviderConfig>>> {
  let promise = providerConfigPromises.get(providerID);
  if (!promise) { promise = getCustomProviderConfig(providerID); providerConfigPromises.set(providerID, promise); }
  return promise;
}

async function probeAvailability(model: FreeModelInfo, config: Awaited<ReturnType<typeof getCustomProviderConfig>>): Promise<Exclude<FreeModelAvailability, "untested">> {
  if (!config) return "unavailable";
  const baseURL = normalizeBaseURL(config.apiUrl);
  try {
    const response = await fetch(`${baseURL}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: model.id, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    return response.ok ? "available" : "unavailable";
  } catch (error) {
    logger.debug(`[FreeModelScan] Availability probe failed for ${model.providerID}/${model.id}`, error);
    return "unavailable";
  }
}

function availabilityKey(model: FreeModelInfo): string { return `${model.providerID}/${model.id}`; }

export async function verifyFreeModelAvailability(models?: FreeModelInfo[]): Promise<FreeModelInfo[]> {
  const candidates = models ?? (await listVerifiedFreeModels());
  const now = Date.now();
  const result = candidates.map((model) => {
    const cached = availabilityCache.get(availabilityKey(model));
    return cached && now < cached.expiresAt ? { ...model, availability: cached.availability } : { ...model, availability: "untested" as const };
  });
  const pending = result.map((model, index) => ({ model, index })).filter(({ model }) => model.availability === "untested");
  let nextPending = 0;
  async function worker(): Promise<void> {
    while (true) {
      const pendingIndex = nextPending++;
      if (pendingIndex >= pending.length) return;
      const entry = pending[pendingIndex];
      if (!entry) return;
      const config = await getCachedProviderConfig(entry.model.providerID);
      const availability = await probeAvailability(entry.model, config);
      availabilityCache.set(availabilityKey(entry.model), { availability, expiresAt: Date.now() + AVAILABILITY_CACHE_TTL_MS });
      result[entry.index] = { ...entry.model, availability };
    }
  }
  await Promise.all(Array.from({ length: Math.min(AVAILABILITY_CONCURRENCY, pending.length) }, () => worker()));
  return result.sort((a, b) => {
    const rank = (value: FreeModelAvailability): number => value === "available" ? 0 : value === "untested" ? 1 : 2;
    return rank(a.availability) - rank(b.availability) || a.providerID.localeCompare(b.providerID) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
}

export function __resetFreeModelScanCacheForTests(): void {
  cache = null;
  inFlight = null;
  availabilityCache.clear();
  providerConfigPromises.clear();
}
