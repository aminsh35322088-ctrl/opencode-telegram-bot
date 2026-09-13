import { createHash } from "node:crypto";
import { getCustomProviderConfig } from "./custom-provider-service.js";
import { peekProviderCatalog } from "./provider-catalog-service.js";
import { classifyModelPrice, type ModelPrice } from "./model-price-classifier.js";
import { getCachedProviderPriceMetadata } from "./model-selection-service.js";

const MAX_PRICE_AGE_MS = 15 * 60_000;
export async function getProviderPriceRevision(providerID: string): Promise<string> {
  const config = await getCustomProviderConfig(providerID);
  return createHash("sha256").update(JSON.stringify(config ?? null)).digest("hex");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

// Config.providers uses SDK Model.cost, not the flat /models pricing schema.
// Preserve unknown fields so an unfamiliar charge cannot silently become free.
function normalizeRuntimePriceTier(value: unknown): unknown {
  const cost = record(value);
  if (!cost) return value;
  const { cache, ...price } = cost;
  const cachePrices = record(cache);
  if (cachePrices && Object.keys(cachePrices).every((key) => key === "read" || key === "write")) {
    if (cachePrices.read !== undefined) price.input_cache_read = cachePrices.read;
    if (cachePrices.write !== undefined) price.input_cache_write = cachePrices.write;
  } else if (cache !== undefined) price.cache = cache;
  return price;
}

function normalizeRuntimePrices(value: unknown): unknown {
  const cost = record(value);
  if (!cost) return value;
  const { experimentalOver200K, ...base } = cost;
  const price = normalizeRuntimePriceTier(base);
  return experimentalOver200K === undefined ? price : [price, normalizeRuntimePriceTier(experimentalOver200K)];
}

function isOfficialOpenCodeModel(providerID: string, api: unknown): boolean {
  const url = record(api)?.url;
  if (providerID !== "opencode" || typeof url !== "string") return false;
  try {
    const endpoint = new URL(url);
    return endpoint.protocol === "https:" && endpoint.hostname === "opencode.ai" && !endpoint.port
      && /^\/zen\/v1(?:\/|$)/.test(endpoint.pathname);
  } catch { return false; }
}

/** Read-only: opening the price view never initiates a network request. */
export async function getProviderModelPrices(providerID: string): Promise<Map<string, ModelPrice>> {
  const result = new Map<string, ModelPrice>();
  const config = await getCustomProviderConfig(providerID);
  if (config) {
    const url = new URL(config.apiUrl.trim());
    const catalog = peekProviderCatalog(url.toString().replace(/\/$/, ""), config.apiKey);
    if (!catalog || Date.now() - catalog.fetchedAt > MAX_PRICE_AGE_MS) return result;
    const officialFreeSuffix = url.protocol === "https:" && url.hostname === "openrouter.ai";
    for (const record of catalog.records) {
      const id = String(record.id).trim();
      const price = classifyModelPrice(record, { officialFreeSuffix });
      const previous = result.get(id);
      result.set(id, previous && previous.group !== price.group ? { group: "conflict", reason: "Duplicate model records disagree." } : price);
    }
    return result;
  }
  const catalog = getCachedProviderPriceMetadata(providerID);
  if (!catalog || Date.now() - catalog.fetchedAt > MAX_PRICE_AGE_MS) return result;
  for (const [id, metadata] of catalog.models) {
    const raw = record(metadata) ?? {};
    const price = classifyModelPrice({ id, name: raw.name, pricing: normalizeRuntimePrices(raw.cost) });
    const officialOpenCode = isOfficialOpenCodeModel(providerID, raw.api);
    // The built-in Zen catalog is its own provider price source. Generic
    // runtime zero estimates remain conservative, including endpoint overrides.
    result.set(id, !officialOpenCode && (price.group === "free" || price.group === "conditional")
      ? { group: "unknown", reason: "Runtime zero estimates are not verified provider pricing." } : price);
  }
  return result;
}
