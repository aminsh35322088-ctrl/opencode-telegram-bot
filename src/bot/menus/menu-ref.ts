import { createHash } from "node:crypto";

/**
 * Short, stable, opaque reference for an entity name in inline-button callback
 * data. Callback payloads are limited to 64 bytes, so raw names cannot be used
 * directly, and Telegram exposes callback data in the message markup.
 *
 * Names are compared case-insensitively by callers so the same entity resolves
 * to the same reference regardless of how it was originally cased.
 */
export function ref(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex").slice(0, 12);
}
