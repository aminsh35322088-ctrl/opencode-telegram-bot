import { logger } from "../../utils/logger.js";
import {
  classifyModelPrice,
  type ModelPrice,
} from "./model-price-classifier.js";

const MODELS_DEV_URL = "https://models.dev/api.json";
const REFRESH_TTL_MS = 6 * 60 * 60_000;
const MAX_STALE_MS = 24 * 60 * 60_000;
const FAILURE_COOLDOWN_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;

interface ModelsDevPriceSnapshot {
  fetchedAt: number;
  providers: Map<string, Map<string, ModelPrice>>;
}

let snapshot: ModelsDevPriceSnapshot | null = null;
let pending: Promise<ModelsDevPriceSnapshot | null> | null = null;
let lastFailureAt = 0;

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeCostTier(value: unknown): Record<string, unknown> | undefined {
  const tier = object(value);
  if (!tier) return undefined;
  const price = { ...tier };
  delete price.tiers;
  delete price.context_over_200k;
  delete price.tier;
  return price;
}

function normalizeModelsDevPricing(costValue: unknown): unknown {
  const cost = object(costValue);
  if (!cost) return undefined;

  const tiers: Record<string, unknown>[] = [];
  const base = normalizeCostTier(cost);
  if (base) tiers.push(base);

  const legacy = normalizeCostTier(cost.context_over_200k);
  if (legacy) tiers.push(legacy);

  if (Array.isArray(cost.tiers)) {
    for (const tier of cost.tiers) {
      const normalized = normalizeCostTier(tier);
      if (normalized) tiers.push(normalized);
    }
  }

  return tiers.length <= 1 ? tiers[0] : tiers;
}

function parseSnapshot(payload: unknown): ModelsDevPriceSnapshot {
  const root = object(payload);
  if (!root) throw new Error("Models.dev returned an invalid catalog");

  const providers = new Map<string, Map<string, ModelPrice>>();

  for (const [providerID, rawProvider] of Object.entries(root)) {
    const provider = object(rawProvider);
    const models = object(provider?.models);
    if (!models) continue;

    const prices = new Map<string, ModelPrice>();
    for (const [modelID, rawModel] of Object.entries(models)) {
      const model = object(rawModel);
      if (!model || model.cost === undefined) continue;

      const pricing = normalizeModelsDevPricing(model.cost);
      if (pricing === undefined) continue;

      const price = classifyModelPrice({
        id: modelID,
        name: model.name,
        pricing,
      });
      prices.set(modelID, {
        ...price,
        reason: "Models.dev: " + price.reason,
      });
    }

    if (prices.size) providers.set(providerID, prices);
  }

  return { fetchedAt: Date.now(), providers };
}

export function peekModelsDevProviderPrices(
  providerID: string,
): Map<string, ModelPrice> | undefined {
  if (!snapshot || Date.now() - snapshot.fetchedAt > MAX_STALE_MS) {
    return undefined;
  }
  return snapshot.providers.get(providerID);
}

export async function refreshModelsDevPriceCatalog(
  options: { force?: boolean } = {},
): Promise<void> {
  const now = Date.now();

  if (
    !options.force &&
    snapshot &&
    now - snapshot.fetchedAt < REFRESH_TTL_MS
  ) {
    return;
  }

  if (
    !options.force &&
    now - lastFailureAt < FAILURE_COOLDOWN_MS
  ) {
    return;
  }

  if (pending) {
    await pending;
    return;
  }

  pending = (async () => {
    try {
      const response = await fetch(MODELS_DEV_URL, {
        headers: {
          Accept: "application/json",
          "User-Agent": "opencode-telegram-bot free-model-detection",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error("HTTP " + response.status);
      }

      const next = parseSnapshot(await response.json());
      snapshot = next;
      lastFailureAt = 0;
      logger.debug(
        "[FreeModelDetection] Models.dev pricing refreshed: providers=" + next.providers.size,
      );
      return next;
    } catch (error) {
      lastFailureAt = Date.now();
      logger.warn(
        "[FreeModelDetection] Models.dev pricing refresh failed; keeping cached evidence",
        error,
      );
      return snapshot;
    }
  })().finally(() => {
    pending = null;
  });

  await pending;
}

export function scheduleModelsDevPriceRefresh(): void {
  void refreshModelsDevPriceCatalog().catch((error) => {
    logger.debug(
      "[FreeModelDetection] Background Models.dev refresh failed",
      error,
    );
  });
}

export function __resetModelsDevPriceCatalogForTests(): void {
  snapshot = null;
  pending = null;
  lastFailureAt = 0;
}
