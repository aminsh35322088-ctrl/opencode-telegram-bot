import { listUnifiedModelCatalog } from "./unified-model-catalog-service.js";
import type { UnifiedModelCatalogEntry } from "../types/model-capability.js";

export const MODEL_CAPABILITY_CATEGORIES = [
  "codingAI",
  "imageAI",
  "voiceToText",
  "videoAI",
] as const;

export type ModelCapabilityCategory = (typeof MODEL_CAPABILITY_CATEGORIES)[number];

export interface ModelCapabilityCategorySummary {
  category: ModelCapabilityCategory;
  label: string;
  description: string;
  models: UnifiedModelCatalogEntry[];
}

const CATEGORY_META: Record<ModelCapabilityCategory, Pick<ModelCapabilityCategorySummary, "label" | "description">> = {
  codingAI: {
    label: "Coding AI",
    description: "Text/chat models available for coding, reasoning, and tool-driven tasks.",
  },
  imageAI: {
    label: "Image AI",
    description: "Models that advertise or are reliably identified as image generators/editors.",
  },
  voiceToText: {
    label: "Voice → Text",
    description: "Models with confirmed or inferred audio-to-text transcription capability.",
  },
  videoAI: {
    label: "Video AI",
    description: "Models that advertise or are reliably identified as video generators.",
  },
};

export function modelMatchesCapabilityCategory(
  model: UnifiedModelCatalogEntry,
  category: ModelCapabilityCategory,
): boolean {
  if (model.availability === "unavailable") return false;
  const capabilities = model.capabilities;
  switch (category) {
    case "codingAI":
      // Preserve older OpenAI-compatible gateways that omit capability metadata,
      // but never show an identified media-only model as a coding model.
      return capabilities.operations.chat === true
        || (capabilities.operations.chat === "unknown"
          && capabilities.operations.imageGenerate !== true
          && capabilities.operations.videoGenerate !== true
          && capabilities.operations.speechToText !== true
          && capabilities.operations.textToSpeech !== true);
    case "imageAI":
      return capabilities.operations.imageGenerate === true || capabilities.operations.imageEdit === true;
    case "voiceToText":
      return capabilities.operations.speechToText === true;
    case "videoAI":
      return capabilities.operations.videoGenerate === true;
  }
}

export function categorizeModelCatalog(
  entries: UnifiedModelCatalogEntry[],
): ModelCapabilityCategorySummary[] {
  return MODEL_CAPABILITY_CATEGORIES.map((category) => ({
    category,
    ...CATEGORY_META[category],
    // Deliberately allow a multimodal chat model to appear in more than one
    // category, as a single API credential can expose many different model types.
    models: entries
      .filter((entry) => modelMatchesCapabilityCategory(entry, category))
      .sort((a, b) => a.providerName.localeCompare(b.providerName)
        || a.modelName.localeCompare(b.modelName)
        || a.modelID.localeCompare(b.modelID)),
  }));
}

export async function getModelCapabilityCategories(): Promise<ModelCapabilityCategorySummary[]> {
  return categorizeModelCatalog(await listUnifiedModelCatalog());
}
