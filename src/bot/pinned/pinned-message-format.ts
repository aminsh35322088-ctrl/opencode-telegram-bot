import { t } from "../../i18n/index.js";

export function formatTokenCount(count: number): string {
  if (count >= 1000000) {
    return `${(count / 1000000).toFixed(1)}M`;
  }

  if (count >= 1000) {
    return `${Math.round(count / 1000)}K`;
  }

  return count.toString();
}

export function formatModelDisplayName(
  providerID?: string | null,
  modelID?: string | null,
): string {
  if (providerID && modelID) {
    return `${providerID}/${modelID}`;
  }

  return t("pinned.unknown");
}

/**
 * Render context usage as a compact visual progress gauge.
 * The percentage is derived only from the measured context window and its
 * provider/model limit; it is not a cost or token-budget control.
 */
export function formatContextLine(tokensUsed: number, tokensLimit?: number | null): string {
  const safeLimit = typeof tokensLimit === "number" && tokensLimit > 0 ? tokensLimit : null;
  const percentage = safeLimit
    ? Math.min(100, Math.max(0, Math.round((tokensUsed / safeLimit) * 100)))
    : 0;
  const segments = 20;
  const filled = safeLimit ? Math.round((percentage / 100) * segments) : 0;
  const gauge = `${"█".repeat(filled)}${"░".repeat(segments - filled)}`;

  return `🧠 Context\n${gauge} ${percentage}%\n${formatTokenCount(tokensUsed)} / ${safeLimit ? formatTokenCount(safeLimit) : t("pinned.unknown")}`;
}

/**
 * Legacy compatibility: cost is provider-specific and is intentionally not
 * presented as a locally calculated spend figure.
 */
export function formatCostLine(_cost: number): string {
  return "";
}
