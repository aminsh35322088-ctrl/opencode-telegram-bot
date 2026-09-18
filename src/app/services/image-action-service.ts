import {
  runImageForSelection,
  type ImageAiCapability,
} from "./image-ai-provider-service.js";
import {
  catalogEntryMatchesSelection,
  listImageModelCatalog,
} from "./image-model-catalog-service.js";
import { getEffectiveImageModel } from "../stores/settings-store.js";
import type { ImageBinary, ImageModelSelection } from "../types/image-model.js";
import { validateImage } from "./ai-http-service.js";

function requirePrompt(prompt: string): string {
  if (!prompt.trim()) throw new Error("Image instruction is empty.");
  if (prompt.length > 6_000) throw new Error("Image instruction is too long.");
  return prompt;
}

export async function resolveConfiguredImageModel(
  capability: ImageAiCapability,
): Promise<ImageModelSelection> {
  const selection = getEffectiveImageModel();
  if (!selection) {
    throw new Error("Image Model is not configured. Open Settings → Default Models → Image Model.");
  }

  const model = (await listImageModelCatalog()).find((candidate) =>
    candidate.capabilities.includes(capability)
    && catalogEntryMatchesSelection(candidate, selection));

  if (!model) {
    throw new Error(
      "The selected Image Model is unavailable or changed. Choose it again under Settings → Models → Image Model.",
    );
  }

  return selection;
}

export async function generateConfiguredImage(
  prompt: string,
  signal: AbortSignal = AbortSignal.timeout(120_000),
): Promise<ImageBinary> {
  const instruction = requirePrompt(prompt);
  const selection = await resolveConfiguredImageModel("generate");
  signal.throwIfAborted();
  return runImageForSelection(selection, instruction, undefined, signal);
}

export async function editConfiguredImage(
  prompt: string,
  source: ImageBinary,
  signal: AbortSignal = AbortSignal.timeout(120_000),
): Promise<ImageBinary> {
  const instruction = requirePrompt(prompt);
  validateImage(source.buffer, source.mimeType);
  const selection = await resolveConfiguredImageModel("edit");
  signal.throwIfAborted();
  return runImageForSelection(selection, instruction, source, signal);
}