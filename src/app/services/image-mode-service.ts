export type ImageMode = "generate" | "edit";

let imageMode: ImageMode | null = null;

/**
 * Explicit, one-shot Image AI mode selected by the Telegram UI.
 * No prompt keyword detection is used here.
 */
export function activateImageMode(mode: ImageMode = "edit"): void {
  imageMode = mode;
}

export function clearImageMode(): void {
  imageMode = null;
}

export function isImageModeActive(): boolean {
  return imageMode !== null;
}

export function getImageMode(): ImageMode | null {
  return imageMode;
}
