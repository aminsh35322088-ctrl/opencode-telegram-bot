import type { VariantInfo } from "./model.js";

export type { VariantInfo };

/**
 * Describes whether the selected OpenCode model actually exposes usable
 * variants. Unsupported and temporarily unavailable are intentionally distinct
 * so the UI never presents a false "Unsupported" state for a transient error.
 */
export type VariantAvailability =
  | {
      supported: true;
      variants: VariantInfo[];
    }
  | {
      supported: false;
      reason: "UNSUPPORTED" | "PROVIDER_NOT_FOUND" | "MODEL_NOT_FOUND" | "UNAVAILABLE";
    };
