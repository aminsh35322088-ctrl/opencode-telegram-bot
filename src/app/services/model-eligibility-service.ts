import { detectModelCapabilities } from "./model-capability-detection-service.js";

export function hasModelInput(metadataValue: unknown, kind: "text" | "image" | "audio" | "video" | "pdf"): boolean {
  return detectModelCapabilities(metadataValue).capabilities.modalities.input[kind] === true;
}

export function hasModelOutput(metadataValue: unknown, kind: "text" | "image" | "audio" | "video" | "pdf"): boolean {
  return detectModelCapabilities(metadataValue).capabilities.modalities.output[kind] === true;
}

/** Compatibility facade: Image AI requires confirmed image output. */
export function isImageModelMetadata(metadataValue: unknown): boolean {
  return detectModelCapabilities(metadataValue).capabilities.operations.imageGenerate === true;
}

/** Compatibility facade: editing requires confirmed image input + output. */
export function isImageEditModelMetadata(metadataValue: unknown): boolean {
  return detectModelCapabilities(metadataValue).capabilities.operations.imageEdit === true;
}

/**
 * Compatibility facade for the existing Chat/Coding Model Center.
 * Confirmed text output is included even when the same model also emits images/audio/video.
 * Unknown legacy metadata remains selectable until the Unified Catalog UI fully replaces this path.
 */
export function isChatModelMetadata(metadataValue: unknown): boolean {
  const state = detectModelCapabilities(metadataValue).capabilities.operations.chat;
  return state !== false;
}
