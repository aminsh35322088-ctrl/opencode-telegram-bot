export type ImageMode = "generate" | "edit";

const imageModes = new Map<string, ImageMode>();
const GLOBAL_KEY = "__global__";

/**
 * Explicit, one-shot Image AI mode selected by the Telegram UI.
 * The mode can be scoped to an OpenCode session so concurrent Topics never
 * leak Generate/Edit state into each other. Legacy callers without a session
 * id continue to use the global compatibility slot.
 */
export function activateImageMode(mode: ImageMode = "edit", sessionId?: string): void {
  imageModes.set(sessionId || GLOBAL_KEY, mode);
}

export function clearImageMode(sessionId?: string): void {
  imageModes.delete(sessionId || GLOBAL_KEY);
}

export function isImageModeActive(sessionId?: string): boolean {
  return imageModes.has(sessionId || GLOBAL_KEY);
}

export function getImageMode(sessionId?: string): ImageMode | null {
  return imageModes.get(sessionId || GLOBAL_KEY) ?? null;
}

export function clearAllImageModes(): void {
  imageModes.clear();
}
