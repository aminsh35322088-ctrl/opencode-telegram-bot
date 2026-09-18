import {
  listCustomProvidersByCapability,
  type CustomProviderModel,
} from "./custom-provider-service.js";
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
  source: "custom-provider" | "legacy-image-provider";
}

function customEntry(
  providerID: string,
  providerName: string,
  model: CustomProviderModel,
): ImageModelCatalogEntry {  return {
    providerID,
    providerName,
    modelID: model.id,
    modelName: model.name || model.id,
    editModelID: model.id,
    capabilities: ["generate", "edit"],
    source: "custom-provider",
  };
}

export async function listImageModelCatalog(): Promise<ImageModelCatalogEntry[]> {
  const [customProviders, legacyProviders] = await Promise.all([
    listCustomProvidersByCapability("image"),
    listImageAiProviders(),
  ]);

  const entries: ImageModelCatalogEntry[] = [];

  for (const provider of customProviders) {
    for (const model of provider.models) {
      entries.push(customEntry(provider.id, provider.name, model));
    }
  }  for (const provider of legacyProviders) {
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

export function imageCatalogSelection(entry: ImageModelCatalogEntry): ImageModelSelection {  return {
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