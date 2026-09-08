const DETERMINISTIC_PROVIDER_ERROR_PATTERNS: readonly RegExp[] = [
  /prompt is longer than the free tier allows for a single request/i,
  /free tier allows for a single request/i,
  /insufficient balance/i,
  /credit insufficient balance/i,
];

const RATE_LIMIT_PROVIDER_ERROR_PATTERNS: readonly RegExp[] = [
  /\btoo many requests\b/i,
  /\brate[\s-]?limit(?:ed|ing)?\b/i,
  /\bconcurrency\s+limit\b/i,
  /\brequest\s+rate\s+exceeds\b/i,
  /\b429\b/i,
  /您的账户已达到速率限制/u,
  /速率限制/u,
];

/**
 * Returns true for provider errors that are not useful to keep retrying inside
 * the OpenCode session retry loop. The Telegram bridge aborts the session when
 * it observes these messages in `session.status=retry`, so the user gets one
 * clear failure instead of an unbounded request storm.
 */
export function isDeterministicProviderRetryError(message: string): boolean {
  const normalized = message.trim();
  if (!normalized) return false;
  return (
    DETERMINISTIC_PROVIDER_ERROR_PATTERNS.some((pattern) => pattern.test(normalized)) ||
    RATE_LIMIT_PROVIDER_ERROR_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}
