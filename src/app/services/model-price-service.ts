import { createHash } from "node:crypto";
import { getCustomProviderConfig } from "./custom-provider-service.js";
import { peekProviderCatalog } from "./provider-catalog-service.js";
import { classifyModelPrice, type ModelPrice } from "./model-price-classifier.js";
import { getUnifiedProviderRevisionData, getUnifiedRuntimePriceMetadata } from "./unified-model-catalog-service.js";
import { peekModelsDevProviderPrices, scheduleModelsDevPriceRefresh } from "./models-dev-price-service.js";

const MAX_PRICE_AGE_MS = 15 * 60_000;
export async function getProviderPriceRevision(providerID: string): Promise<string> {
  const [config, catalog] = await Promise.all([
    getCustomProviderConfig(providerID),
    getUnifiedProviderRevisionData(providerID),
  ]);
  const custom = config
    ? {
        apiUrl: config.apiUrl,
        credential: createHash("sha256").update(config.apiKey).digest("hex"),
        capability: config.capability,
        models: config.models.map((model) => model.id).sort(),
      }
    : null;
  return createHash("sha256").update(JSON.stringify({ custom, catalog })).digest("hex");
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

function mergePriceEvidence(primary: ModelPrice, secondary: ModelPrice | undefined): ModelPrice {
  if (!secondary) return primary;
  if (primary.group === "conflict" || secondary.group === "conflict") {
    return { group: "conflict", reason: primary.reason + " " + secondary.reason };
  }

  const primaryFree = primary.group === "free" || primary.group === "conditional";
  const secondaryFree = secondary.group === "free" || secondary.group === "conditional";
  if ((primary.group === "paid" && secondaryFree) || (secondary.group === "paid" && primaryFree)) {
    return { group: "conflict", reason: "Runtime and Models.dev pricing evidence disagree." };
  }

  if (primary.group === "paid" || primaryFree) return primary;
  if (secondary.group === "paid" || secondaryFree) return secondary;
  if (primary.group === "hint") return primary;
  return secondary.group === "hint" ? secondary : primary;
}

/** Returns cached evidence immediately; any Models.dev refresh is background-only. */
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
  const modelsDev = peekModelsDevProviderPrices(providerID);
  if (!modelsDev) scheduleModelsDevPriceRefresh();

  const catalog = getUnifiedRuntimePriceMetadata(providerID);
  if (!catalog || Date.now() - catalog.fetchedAt > MAX_PRICE_AGE_MS) {
    return modelsDev ? new Map(modelsDev) : result;
  }

  for (const [id, metadata] of catalog.models) {
    const raw = record(metadata) ?? {};
    const classified = classifyModelPrice({ id, name: raw.name, pricing: normalizeRuntimePrices(raw.cost) });
    const officialOpenCode = isOfficialOpenCodeModel(providerID, raw.api);
    const runtimePrice = !officialOpenCode && (classified.group === "free" || classified.group === "conditional")
      ? { group: "unknown" as const, reason: "Runtime zero estimates are not verified provider pricing." }
      : classified;
    result.set(id, mergePriceEvidence(runtimePrice, modelsDev?.get(id)));
  }

  for (const [id, price] of modelsDev ?? []) {
    if (!result.has(id)) result.set(id, price);
  }
  return result;
}
