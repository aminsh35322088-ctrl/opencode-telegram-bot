/**
 * Compatibility shim for legacy event wiring.
 * Audio replies were removed; callers should not send synthesized audio.
 */
export async function sendTtsResponseForSession(): Promise<boolean> {
  return false;
}
