import { getCurrentSession } from "./session-service.js";

export type ImageMode = "generate" | "edit";

const imageModes = new Map<string, ImageMode>();
const GLOBAL_KEY = "__global__";

function resolveKey(sessionId?: string): string {
  return sessionId ?? getCurrentSession()?.id ?? GLOBAL_KEY;
}

/** Explicit, one-shot Image AI mode, scoped to the current OpenCode session. */
export function activateImageMode(mode: ImageMode = "edit", sessionId?: string): void {
  imageModes.set(resolveKey(sessionId), mode);
}

export function clearImageMode(sessionId?: string): void {
  imageModes.delete(resolveKey(sessionId));
}

export function isImageModeActive(sessionId?: string): boolean {
  return imageModes.has(resolveKey(sessionId));
}

export function getImageMode(sessionId?: string): ImageMode | null {
  return imageModes.get(resolveKey(sessionId)) ?? null;
}

export function clearAllImageModes(): void {
  imageModes.clear();
}
