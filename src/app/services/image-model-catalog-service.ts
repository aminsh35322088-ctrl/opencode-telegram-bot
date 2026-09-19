import { opencodeClient } from "../../opencode/client.js";
import { isImageEditModelMetadata, isImageModelMetadata } from "./model-eligibility-service.js";
import {
  listImageAiProviders,
  type ImageAiCapability,
} from "./image-ai-provider-service.js";
import type { ImageModelSelection } from "../types/image-model.js";

export interface ImageModelCatalogEntry {
  providerID: string;
  providerName: string;
  modelID: string;
  modelName: string;
  editModelID?: string;
  capabilities: ImageAiCapability[];
  source: "opencode-provider" | "legacy-image-provider";
}

function advertisedName(metadata: unknown, fallback: string): string {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return fallback;
  const name = (metadata as { name?: unknown }).name;
  return typeof name === "string" && name.trim() ? name.trim() : fallback;
}

/**
 * Canonical Image Model catalog.
 *
 * OpenCode's provider catalog is authoritative for normal AI connections:
 * every model is classified by its own output/input capabilities, not by a
 * provider-level "chat" or "image" category. Legacy direct image adapters are
 * appended only while the old subsystem is being migrated.
 */
export async function listImageModelCatalog(): Promise<ImageModelCatalogEntry[]> {
  const [providerResponse, legacyProviders] = await Promise.all([
    opencodeClient.config.providers(),
    listImageAiProviders(),
  ]);

  const entries: ImageModelCatalogEntry[] = [];

  if (!providerResponse.error && providerResponse.data) {
    for (const provider of providerResponse.data.providers) {
      for (const [modelID, metadata] of Object.entries(provider.models)) {
        if (!isImageModelMetadata(metadata)) continue;
        const editable = isImageEditModelMetadata(metadata);
        entries.push({
          providerID: provider.id,
          providerName: provider.name || provider.id,
          modelID,
          modelName: advertisedName(metadata, modelID),
          ...(editable ? { editModelID: modelID } : {}),
          capabilities: editable ? ["generate", "edit"] : ["generate"],
          source: "opencode-provider",
        });
      }
    }
  }

  for (const provider of legacyProviders) {
    if (!provider.active) continue;
    entries.push({
      providerID: provider.id,
      providerName: provider.name,
      modelID: provider.model,
      modelName: provider.model,
      ...(provider.editModel ? { editModelID: provider.editModel } : {}),
      capabilities: [...provider.capabilities],
      source: "legacy-image-provider",
    });
  }

  const seen = new Set<string>();
  return entries
    .filter((entry) => {
      const key = entry.providerID + "\0" + entry.modelID + "\0" + (entry.editModelID ?? "");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) =>
      a.providerName.localeCompare(b.providerName)
      || a.modelName.localeCompare(b.modelName));
}

export function imageCatalogSelection(entry: ImageModelCatalogEntry): ImageModelSelection {
  return {
    providerID: entry.providerID,
    modelID: entry.modelID,
    ...(entry.editModelID ? { editModelID: entry.editModelID } : {}),
  };
}

export function catalogEntryMatchesSelection(
  entry: ImageModelCatalogEntry,
  selection: ImageModelSelection,
): boolean {
  return entry.providerID === selection.providerID
    && entry.modelID === selection.modelID
    && (entry.editModelID ?? entry.modelID) === (selection.editModelID ?? selection.modelID);
}