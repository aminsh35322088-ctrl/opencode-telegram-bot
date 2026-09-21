import { runImageForSelection, type ImageAiCapability } from "./image-ai-provider-service.js";
import { imageCatalogSelection, listImageModelCatalog } from "./image-model-catalog-service.js";
import type { ImageBinary, ImageModelSelection } from "../types/image-model.js";
import { validateImage } from "./ai-http-service.js";
import { resolveCapabilityRoute } from "./model-capability-routing-service.js";

function requirePrompt(prompt: string): string {
  if (!prompt.trim()) throw new Error("Image instruction is empty.");
  if (prompt.length > 6_000) throw new Error("Image instruction is too long.");
  return prompt;
}

export async function resolveConfiguredImageModel(capability: ImageAiCapability, worktree?: string): Promise<ImageModelSelection> {
  const route = await resolveCapabilityRoute(capability === "edit" ? "imageEdit" : "imageGenerate", worktree);
  if (!route.model) {
    throw new Error(route.reason ?? "Image AI is unavailable. Configure an Image AI model under Settings → Default Models.");
  }

  const model = (await listImageModelCatalog()).find((candidate) =>
    candidate.providerID === route.model!.providerID
    && candidate.modelID === route.model!.modelID
    && candidate.capabilities.includes(capability));
  if (!model) {
    throw new Error("The routed Image AI model is unavailable or no longer supports this operation. Choose it again in Model Center.");
  }
  return imageCatalogSelection(model);
}

export async function generateConfiguredImage(prompt: string, signal: AbortSignal = AbortSignal.timeout(120_000), worktree?: string): Promise<ImageBinary> {
  const instruction = requirePrompt(prompt);
  const selection = await resolveConfiguredImageModel("generate", worktree);
  signal.throwIfAborted();
  return runImageForSelection(selection, instruction, undefined, signal, worktree);
}

export async function editConfiguredImage(prompt: string, source: ImageBinary, signal: AbortSignal = AbortSignal.timeout(120_000), worktree?: string): Promise<ImageBinary> {
  const instruction = requirePrompt(prompt);
  validateImage(source.buffer, source.mimeType);
  const selection = await resolveConfiguredImageModel("edit", worktree);
  signal.throwIfAborted();
  return runImageForSelection(selection, instruction, source, signal, worktree);
}
