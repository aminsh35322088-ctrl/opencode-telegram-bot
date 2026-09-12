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
    const raw = metadata as { name?: string; cost?: unknown };
    const price = classifyModelPrice({ id, name: raw.name, pricing: raw.cost });
    // Runtime zero costs can be defaults, not authoritative upstream prices.
    result.set(id, price.group === "free" || price.group === "conditional"
      ? { group: "unknown", reason: "Runtime zero estimates are not verified provider pricing." } : price);
  }
  return result;
}
