/**
 * OpenCode is the source of truth for provider retryability.
 *
 * The upstream runtime already classifies context overflow and permanent API
 * errors, honors Retry-After, and applies bounded backoff for transient 429/5xx
 * and transport failures. The Telegram bridge must not second-guess that
 * decision by aborting a session while OpenCode is intentionally retrying it.
 *
 * Keep this compatibility hook while older event-bus code still calls it; it
 * deliberately never intercepts an OpenCode retry status.
 */
export function isDeterministicProviderRetryError(_message: string): boolean {
  return false;
}
