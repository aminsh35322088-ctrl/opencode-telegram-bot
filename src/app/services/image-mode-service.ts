let imageModeActive = false;

/**
 * Explicit, one-shot Image AI mode selected by the Telegram keyboard.
 * No prompt keyword detection is used here.
 */
export function activateImageMode(): void {
  imageModeActive = true;
}

export function clearImageMode(): void {
  imageModeActive = false;
}

export function isImageModeActive(): boolean {
  return imageModeActive;
}
