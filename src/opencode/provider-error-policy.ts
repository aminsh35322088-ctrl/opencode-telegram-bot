const DETERMINISTIC_PROVIDER_ERROR_PATTERNS: readonly RegExp[] = [
  /prompt is longer than the free tier allows for a single request/i,
  /free tier allows for a single request/i,
  /insufficient balance/i,
  /credit insufficient balance/i,
];

export function isDeterministicProviderRetryError(message: string): boolean {
  const normalized = message.trim();
  return normalized.length > 0 && DETERMINISTIC_PROVIDER_ERROR_PATTERNS.some((pattern) => pattern.test(normalized));
}
