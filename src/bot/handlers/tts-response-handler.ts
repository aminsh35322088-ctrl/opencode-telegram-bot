/**
 * Compatibility shim for legacy event wiring.
 * Audio replies were removed; callers must not synthesize or send audio.
 */
export async function sendTtsResponseForSession(..._args: unknown[]): Promise<boolean> {
  return false;
}
