import { randomBytes } from "node:crypto";
import type { FavoriteModel } from "../../app/types/model.js";
import { getFreeModelDetectionEnabled } from "../../app/stores/settings-store.js";
import { getProviderModelPrices, getProviderPriceRevision } from "../../app/services/model-price-service.js";
import { PRICE_ORDER, type ModelPrice } from "../../app/services/model-price-classifier.js";

interface PriceView { revision: string; id: string; providerID: string; models: FavoriteModel[]; prices: Map<string, ModelPrice>; expiresAt: number; }
const views = new Map<string, PriceView>();
let generation = 0;
const MAX_VIEWS = 64;
const VIEW_TTL_MS = 15 * 60_000;
export class PriceViewExpiredError extends Error {
  constructor() { super("Price view expired or provider changed. Reopen the provider."); }
}
export function clearProviderPriceViews(): void { generation++; views.clear(); }
export function resolvePriceViewProvider(id: string): string | undefined { return views.get(id)?.providerID; }

/** A bounded snapshot for each menu keeps pages stable through refreshes. */
export async function getProviderPriceView(providerID: string, models: FavoriteModel[], id?: string): Promise<PriceView | undefined> {
  if (!getFreeModelDetectionEnabled()) return undefined;
  const now = Date.now();
  for (const [key, view] of views) if (view.expiresAt <= now) views.delete(key);
  const started = generation;
  const revision = await getProviderPriceRevision(providerID);
  if (!getFreeModelDetectionEnabled() || generation !== started) return undefined;
  if (id) {
    const existing = views.get(id);
    if (!existing || existing.providerID !== providerID || existing.revision !== revision) throw new PriceViewExpiredError();
    return existing;
  }
  const prices = await getProviderModelPrices(providerID);
  if (!getFreeModelDetectionEnabled() || generation !== started) return undefined;
  if (revision !== await getProviderPriceRevision(providerID)) throw new PriceViewExpiredError();
  if (!getFreeModelDetectionEnabled() || generation !== started) return undefined;
  const sorted = [...models].sort((a, b) => PRICE_ORDER[prices.get(a.modelID)?.group ?? "unknown"] - PRICE_ORDER[prices.get(b.modelID)?.group ?? "unknown"]);
  const view = { revision, id: randomBytes(6).toString("base64url"), providerID, models: sorted, prices, expiresAt: now + VIEW_TTL_MS };
  views.set(view.id, view);
  while (views.size > MAX_VIEWS) views.delete(views.keys().next().value!);
  return view;
}
