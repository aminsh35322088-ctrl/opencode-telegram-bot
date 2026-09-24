import { listUnifiedModelCatalog } from "./unified-model-catalog-service.js";
import type { ImageAiCapability } from "./image-ai-provider-service.js";
import type { ImageModelSelection } from "../types/image-model.js";

export interface ImageModelCatalogEntry {
  providerID: string;
  providerName: string;
  modelID: string;
  modelName: string;
  editModelID?: string;
  capabilities: ImageAiCapability[];
  source: "unified-model-catalog";
}

/** Temporary compatibility view. The Unified Model Catalog is the source of truth. */
export async function listImageModelCatalog(): Promise<ImageModelCatalogEntry[]> {
  return (await listUnifiedModelCatalog())
    .filter((entry) => entry.capabilities.operations.imageGenerate === true || entry.capabilities.operations.imageEdit === true)
    .map<ImageModelCatalogEntry>((entry) => {
      const editable = entry.capabilities.operations.imageEdit === true;
      return {
        providerID: entry.providerID,
        providerName: entry.providerName,
        modelID: entry.modelID,
        modelName: entry.modelName,
        ...(editable ? { editModelID: entry.modelID } : {}),
        capabilities: editable ? ["generate", "edit"] : ["generate"],
        source: "unified-model-catalog" as const,
      };
    })
    .sort((a, b) => a.providerID.localeCompare(b.providerID) || a.modelID.localeCompare(b.modelID));
}

export function imageCatalogSelection(entry: ImageModelCatalogEntry): ImageModelSelection {
  return {
    providerID: entry.providerID,
    modelID: entry.modelID,
    ...(entry.editModelID ? { editModelID: entry.editModelID } : {}),
  };
}

export function catalogEntryMatchesSelection(entry: ImageModelCatalogEntry, selection: ImageModelSelection): boolean {
  return entry.providerID === selection.providerID
    && entry.modelID === selection.modelID
    && (entry.editModelID ?? entry.modelID) === (selection.editModelID ?? selection.modelID);
}
