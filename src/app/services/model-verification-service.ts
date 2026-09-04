export type FreeModelStatus = "free" | "paid" | "unknown";
export type FreeModelConfidence = "high" | "medium" | "low" | "none";
export type FreeModelEvidenceSource = "explicit" | "pricing" | "id" | "heuristic" | "none";

export interface ModelPricing {
  prompt?: number;
  completion?: number;
  request?: number;
  image?: number;
  inputCacheRead?: number;
  inputCacheWrite?: number;
}

export interface FreeModelAnalysis {
  status: FreeModelStatus;
  confidence: FreeModelConfidence;
  source: FreeModelEvidenceSource;
  reason: string;
  pricing?: ModelPricing;
}

export interface DiscoveredProviderModel {
  id: string;
  name: string;
  freeStatus: FreeModelStatus;
  freeConfidence: FreeModelConfidence;
  freeSource: FreeModelEvidenceSource;
  freeReason: string;
  pricing?: ModelPricing;
}

interface ModelMetadataInput {
  id: string;
  name?: unknown;
  pricing?: unknown;
  free?: unknown;
  is_free?: unknown;
  metadata?: unknown;
}

const REQUEST_TIMEOUT_MS = 10_000;
const PRICING_FIELDS: Array<[keyof ModelPricing, string[]]> = [
  ["prompt", ["prompt", "input"]],
  ["completion", ["completion", "output"]],
  ["request", ["request"]],
  ["image", ["image"]],
  ["inputCacheRead", ["input_cache_read", "cache_read"]],
  ["inputCacheWrite", ["input_cache_write", "cache_write"]],
];

function normalizeBaseURL(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Base URL must use http:// or https://");
  return url.toString().replace(/\/$/, "");
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return undefined;
}

function extractPricing(value: unknown): ModelPricing | undefined {
  const candidates = Array.isArray(value) ? value : [value];
  const pricing: ModelPricing = {};
  let found = false;

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    for (const [field, aliases] of PRICING_FIELDS) {
      for (const alias of aliases) {
        const numeric = numericValue(record[alias]);
        if (numeric !== undefined) {
          pricing[field] = Math.max(pricing[field] ?? 0, numeric);
          found = true;
          break;
        }
      }
    }
  }

  return found ? pricing : undefined;
}

function findExplicitFree(value: unknown): boolean | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const direct = booleanValue(record.free ?? record.is_free);
  if (direct !== undefined) return direct;
  if (record.metadata && record.metadata !== value) return findExplicitFree(record.metadata);
  return undefined;
}

function hasPositivePricing(pricing: ModelPricing): boolean {
  return Object.values(pricing).some((value) => typeof value === "number" && value > 0);
}

function hasCompleteZeroPricing(pricing: ModelPricing): boolean {
  const values = Object.values(pricing).filter((value): value is number => typeof value === "number");
  return values.length >= 2 && values.every((value) => value === 0);
}

export function analyzeModel(model: ModelMetadataInput): FreeModelAnalysis {
  const pricing = extractPricing(model.pricing);
  const explicitFree = findExplicitFree(model) ?? findExplicitFree(model.metadata);
  const freeVariant = /:free$/i.test(model.id.trim());

  if (explicitFree === true && pricing && hasPositivePricing(pricing)) {
    return { status: "unknown", confidence: "medium", source: "explicit", reason: "Free metadata conflicts with non-zero pricing; the model is not classified automatically.", pricing };
  }

  if (explicitFree === false && pricing && hasCompleteZeroPricing(pricing)) {
    return { status: "unknown", confidence: "medium", source: "explicit", reason: "Non-free metadata conflicts with zero pricing; the model is not classified automatically.", pricing };
  }

  if (explicitFree === true) {
    return { status: "free", confidence: "high", source: "explicit", reason: "Provider metadata explicitly marks this model as free.", ...(pricing ? { pricing } : {}) };
  }

  if (pricing && hasPositivePricing(pricing)) {
    return { status: "paid", confidence: "high", source: "pricing", reason: "Provider metadata contains a non-zero model price.", pricing };
  }

  if (explicitFree === false) {
    return { status: "paid", confidence: "medium", source: "explicit", reason: "Provider metadata explicitly marks this model as not free.", ...(pricing ? { pricing } : {}) };
  }

  if (pricing && hasCompleteZeroPricing(pricing)) {
    return { status: "free", confidence: "high", source: "pricing", reason: "Provider pricing reports zero cost for all advertised billable fields.", pricing };
  }

  if (freeVariant) {
    return pricing && hasPositivePricing(pricing)
      ? { status: "unknown", confidence: "medium", source: "id", reason: "The model uses a :free suffix but also exposes non-zero pricing; it is not classified automatically.", pricing }
      : { status: "free", confidence: "high", source: "id", reason: "Model ID uses the provider's explicit :free variant convention.", ...(pricing ? { pricing } : {}) };
  }

  const name = typeof model.name === "string" ? model.name : "";
  if (/\bfree\b/i.test(name) || /\bfree\b/i.test(model.id)) {
    return { status: "free", confidence: "low", source: "heuristic", reason: "Model name or ID contains a free marker without authoritative pricing metadata.", ...(pricing ? { pricing } : {}) };
  }

  return { status: "unknown", confidence: "none", source: "none", reason: "The provider did not expose enough pricing information to classify this model safely.", ...(pricing ? { pricing } : {}) };
}

export function analyzeModels(models: ModelMetadataInput[]): FreeModelAnalysis[] {
  return models.map(analyzeModel);
}

export function isVerifiedFreeModel(analysis: FreeModelAnalysis): boolean {
  return analysis.status === "free" && analysis.confidence === "high";
}

export async function discoverProviderModels(baseURL: string, apiKey: string): Promise<DiscoveredProviderModel[]> {
  const normalizedURL = normalizeBaseURL(baseURL);
  const key = apiKey.trim();
  if (!key) throw new Error("API key is empty");

  const response = await fetch(`${normalizedURL}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`Model discovery failed: HTTP ${response.status}`);

  const payload = (await response.json()) as { data?: unknown };
  const data = Array.isArray(payload.data) ? payload.data : [];
  const models: DiscoveredProviderModel[] = [];

  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id.trim()) continue;

    const id = record.id.trim();
    const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : id;
    const analysis = analyzeModel({
      id,
      name,
      pricing: record.pricing,
      free: record.free,
      is_free: record.is_free,
      metadata: record.metadata,
    });

    models.push({
      id,
      name,
      freeStatus: analysis.status,
      freeConfidence: analysis.confidence,
      freeSource: analysis.source,
      freeReason: analysis.reason,
      ...(analysis.pricing ? { pricing: analysis.pricing } : {}),
    });
  }

  if (!models.length) throw new Error("Provider returned no models from /models");
  return models;
}
