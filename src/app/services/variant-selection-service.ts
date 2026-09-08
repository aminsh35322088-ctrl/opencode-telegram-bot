/**
 * Variant manager - reads model-specific variants from OpenCode metadata.
 *
 * Important: OpenCode owns the variant semantics. This service must never
 * invent a variant for a model that does not expose one.
 */
import { opencodeClient } from "../../opencode/client.js";
import { getCurrentModel, setCurrentModel } from "../stores/settings-store.js";
import { logger } from "../../utils/logger.js";
import type { VariantAvailability, VariantInfo } from "../types/variant.js";

function normalizeVariants(input: unknown): VariantInfo[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];

  return Object.entries(input as Record<string, unknown>).map(([id, info]) => {
    const disabled =
      typeof info === "object" && info !== null && !Array.isArray(info)
        ? (info as { disabled?: unknown }).disabled
        : undefined;

    return {
      id,
      ...(typeof disabled === "boolean" ? { disabled } : {}),
    };
  });
}

/**
 * Resolve model variant capability directly from OpenCode's provider catalog.
 *
 * `UNSUPPORTED` means the model exists and exposes no variants. API/provider
 * failures remain distinguishable so a transient outage is not mislabeled.
 */
export async function getVariantAvailability(
  providerID: string,
  modelID: string,
): Promise<VariantAvailability> {
  if (!providerID || !modelID) {
    return { supported: false, reason: "MODEL_NOT_FOUND" };
  }

  try {
    const { data, error } = await opencodeClient.config.providers();

    if (error || !data) {
      logger.warn("[VariantManager] Failed to fetch providers:", error);
      return { supported: false, reason: "UNAVAILABLE" };
    }

    const provider = data.providers.find((item) => item.id === providerID);
    if (!provider) {
      logger.warn(`[VariantManager] Provider ${providerID} not found`);
      return { supported: false, reason: "PROVIDER_NOT_FOUND" };
    }

    const model = provider.models[modelID];
    if (!model) {
      logger.warn(`[VariantManager] Model ${modelID} not found in provider ${providerID}`);
      return { supported: false, reason: "MODEL_NOT_FOUND" };
    }

    const variants = normalizeVariants(model.variants);
    if (variants.length === 0) {
      logger.debug(`[VariantManager] Model ${providerID}/${modelID} does not expose variants`);
      return { supported: false, reason: "UNSUPPORTED" };
    }

    const enabledVariants = variants.filter((variant) => !variant.disabled);
    logger.debug(
      `[VariantManager] Found ${variants.length} variants for ${providerID}/${modelID}; enabled=${enabledVariants.length}`,
    );
    return { supported: true, variants };
  } catch (err) {
    logger.error("[VariantManager] Error fetching variant metadata:", err);
    return { supported: false, reason: "UNAVAILABLE" };
  }
}

/**
 * Backwards-compatible list API. Unsupported/unavailable models return an
 * empty list rather than a fabricated `default` variant.
 */
export async function getAvailableVariants(
  providerID: string,
  modelID: string,
): Promise<VariantInfo[]> {
  const availability = await getVariantAvailability(providerID, modelID);
  return availability.supported ? availability.variants : [];
}

/**
 * Get current stored variant. `default` is an internal no-explicit-variant
 * sentinel and is not treated as proof that the model supports variants.
 */
export function getCurrentVariant(): string {
  return getCurrentModel()?.variant || "default";
}

/** Set current variant in settings after the caller validates support. */
export function setCurrentVariant(variantId: string): void {
  const currentModel = getCurrentModel();
  if (!currentModel) {
    logger.warn("[VariantManager] Cannot set variant: no current model");
    return;
  }

  currentModel.variant = variantId;
  setCurrentModel(currentModel);
  logger.info(`[VariantManager] Variant set to: ${variantId}`);
}

export function formatVariantForButton(variantId: string): string {
  const capitalized = variantId.charAt(0).toUpperCase() + variantId.slice(1);
  return `💡 ${capitalized}`;
}

export function formatVariantForDisplay(variantId: string): string {
  return variantId.charAt(0).toUpperCase() + variantId.slice(1);
}

/** Validate a variant against the selected model's actual OpenCode metadata. */
export async function validateVariantForModel(
  providerID: string,
  modelID: string,
  variantId: string,
): Promise<boolean> {
  const availability = await getVariantAvailability(providerID, modelID);
  if (!availability.supported) return false;

  return availability.variants.some((variant) => variant.id === variantId && !variant.disabled);
}
