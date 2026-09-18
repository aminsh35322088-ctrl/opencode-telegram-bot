import {
  listImageAiProviders,
  runImageForSelection,
  type ImageAiCapability,
  type ImageAiProviderStatus,
} from "./image-ai-provider-service.js";
import { getEffectiveImageModel } from "../stores/settings-store.js";
import type { ImageBinary, ImageModelSelection } from "../types/image-model.js";
import { validateImage } from "./ai-http-service.js";

function sameProviderSelection(
  provider: ImageAiProviderStatus,
  selection: ImageModelSelection,
): boolean {
  return provider.id === selection.providerID
    && provider.model === selection.modelID
    && (provider.editModel ?? provider.model) === (selection.editModelID ?? selection.modelID);
}

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

  const provider = (await listImageAiProviders()).find((candidate) =>
    candidate.active
    && candidate.capabilities.includes(capability)
    && sameProviderSelection(candidate, selection));

  if (!provider) {
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
