export type PriceGroup = "free" | "conditional" | "hint" | "unknown" | "conflict" | "paid";
export interface ModelPrice { group: PriceGroup; reason: string; }
export const PRICE_ORDER: Record<PriceGroup, number> = { free: 0, conditional: 1, hint: 2, unknown: 3, conflict: 4, paid: 5 };
export const PRICE_COLOR: Record<PriceGroup, string> = { free: "🟢", conditional: "🟢", hint: "🟡", unknown: "⚪", conflict: "🟠", paid: "🔴" };
export const PRICE_LEGEND = "🟢 Advertised free (may have limits)\n🟡 Free hints only\n⚪ Unknown / outdated price\n🟠 Conflicting prices\n🔴 Paid\nText pricing only; excludes optional extras. Colors do not prove availability.";

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function boolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && /^(true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === "true";
  return undefined;
}
function number(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Advertised text prices only; successful requests never change the price group. */
export function classifyModelPrice(raw: unknown, options: { officialFreeSuffix?: boolean } = {}): ModelPrice {
  const record = object(raw) ?? {};
  const metadata = object(record.metadata) ?? {};
  const flags = [record.free, record.is_free, metadata.free, metadata.is_free].map(boolean).filter((v) => v !== undefined);
  const free = flags.includes(true);
  const notFree = flags.includes(false);
  const result = (group: PriceGroup, reason: string): ModelPrice => ({ group, reason });
  if (free && notFree) return result("conflict", "Provider free flags disagree.");
  const source = record.pricing;
  const tiers = source === undefined ? [] : Array.isArray(source) ? source : [source];
  let invalid = source !== undefined && !tiers.length;
  let conflicting = false;
  let positive = false;
  let completeZero = tiers.length > 0;
  let zeroTier = false;
  for (const tier of tiers) {
    const price = object(tier);
    if (!price) { invalid = true; completeZero = false; continue; }
    const fields = [["prompt", "input"], ["completion", "output"], ["request"], ["input_cache_read", "cache_read"], ["input_cache_write", "cache_write"]];
    const values: Array<number | undefined> = [];
    for (const aliases of fields) {
      const advertised = aliases.filter((key) => price[key] !== undefined).map((key) => number(price[key]));
      if (advertised.some((value) => value === undefined)) invalid = true;
      const valid = advertised.filter((v): v is number => v !== undefined);
      if (new Set(valid).size > 1) conflicting = true;
      if (valid.some((v) => v > 0)) positive = true;
      values.push(valid[0]);
    }
    // Optional non-text features do not price plain text. Unrecognized
    // dimensions prevent a free verdict instead of being silently ignored.
    const known = new Set([...fields.flat(), "image", "audio", "video", "web_search", "internal_reasoning", "discount"]);
    if (Object.keys(price).some((key) => !known.has(key))) invalid = true;
    if (price.internal_reasoning !== undefined) {
      const reasoning = number(price.internal_reasoning);
      if (reasoning === undefined) invalid = true;
      else if (reasoning > 0) positive = true;
    }
    const zero = values[0] === 0 && values[1] === 0 && values.every((v) => v === undefined || v === 0) && (price.internal_reasoning === undefined || number(price.internal_reasoning) === 0);
    zeroTier ||= zero;
    completeZero &&= zero;
  }
  const suffix = options.officialFreeSuffix === true && typeof record.id === "string" && /:free$/i.test(record.id);
  if (conflicting || ((free || suffix) && positive) || (notFree && (completeZero || suffix))) return result("conflict", "Authoritative price fields disagree.");
  if (positive && zeroTier && !invalid && !notFree) return result("conditional", "Only some advertised pricing tiers are free; eligibility is not verified.");
  if (positive || notFree) return result("paid", "Provider advertises a charge for text inference.");
  if (!invalid && (completeZero || free || suffix)) return result("free", "Provider advertises free text inference; quotas and account conditions may apply.");
  if (free || suffix || /\bfree\b/i.test(String(record.id ?? "") + " " + String(record.name ?? ""))) return result("hint", "Free marker without complete, consistent pricing evidence.");
  return result("unknown", "Provider did not expose complete, valid text pricing.");
}
