/**
 * Compatibility boundary for legacy event wiring.
 * Audio replies are removed: this function intentionally performs no I/O.
 * The boundary remains temporarily so older event wiring cannot break startup.
 */
export async function sendTtsResponseForSession(..._args: unknown[]): Promise<boolean> {
  return false;
}
