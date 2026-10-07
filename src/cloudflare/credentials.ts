const encoder = new TextEncoder();
function bytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
function base64(value: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(value)));
}
async function key(master: string) {
  const raw = bytes(master);
  if (raw.length !== 32) throw new Error("invalid_master_key");
  return crypto.subtle.importKey("raw", raw.slice().buffer, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
/** Only the privileged Control Plane uses this key; context prevents credential substitution. */
export async function encryptCredential(
  master: string,
  context: string,
  secret: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
    await key(master),
    encoder.encode(secret),
  );
  return JSON.stringify({ version: 1, iv: base64(iv), cipher: base64(cipher) });
}
export async function decryptCredential(
  master: string,
  context: string,
  blob: string,
): Promise<string> {
  const value = JSON.parse(blob) as { version: number; iv: string; cipher: string };
  if (value.version !== 1) throw new Error("invalid_credential");
  const result = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: bytes(value.iv).slice().buffer,
      additionalData: encoder.encode(context),
    },
    await key(master),
    bytes(value.cipher).slice().buffer,
  );
  return new TextDecoder().decode(result);
}
export async function sha256(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
export function randomSecret(): string {
  return base64(crypto.getRandomValues(new Uint8Array(48)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
