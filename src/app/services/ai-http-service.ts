/** Bounded responses; never log provider bodies or credentials. No automatic inference retries. */
export async function readBoundedJson(response: Response, maxBytes = 32 * 1024 * 1024): Promise<unknown> {
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`Provider request failed (HTTP ${response.status}). Check connection, quota and model availability.`); }
  if (!response.body) throw new Error("Provider returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Provider response exceeds the image size limit");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Provider returned an invalid JSON response");
  }
}
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function detectImageMimeType(buffer: Buffer): string | undefined {
  if (!buffer.length || buffer.length > 8 * 1024 * 1024) throw new Error("Images must be under 8 MB");
  const png = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  const webp = buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
  return png ? "image/png" : jpg ? "image/jpeg" : webp ? "image/webp" : undefined;
}
export function validateImage(buffer: Buffer, mimeType: string): void {
  if (detectImageMimeType(buffer) !== mimeType) throw new Error("Only valid PNG, JPEG and WebP images are supported");
}
