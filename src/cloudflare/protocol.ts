import type { NodeEnvelope } from "../control-plane/node-protocol.js";
const encode = new TextEncoder();
// Explicit algorithm avoids any reliance on Node crypto or filesystem replay ledgers.
async function hmacKey(secret: string) {
  if (secret.length < 48) throw new Error("invalid_node_key");
  return crypto.subtle.importKey(
    "raw",
    encode.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function signEnvelope(
  envelope: NodeEnvelope,
  secret: string,
): Promise<{ body: string; signature: string }> {
  const body = JSON.stringify(envelope);
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encode.encode(body));
  return {
    body,
    signature: [...new Uint8Array(signature)].map((v) => v.toString(16).padStart(2, "0")).join(""),
  };
}
export async function verifyEnvelope(
  body: string,
  signature: string,
  secret: string,
  now = Date.now(),
): Promise<NodeEnvelope> {
  if (encode.encode(body).length > 10 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(signature))
    throw new Error("signature_rejected");
  const raw = Uint8Array.from(signature.match(/../g)!, (v) => parseInt(v, 16));
  if (!(await crypto.subtle.verify("HMAC", await hmacKey(secret), raw, encode.encode(body))))
    throw new Error("signature_rejected");
  const value = JSON.parse(body) as NodeEnvelope;
  if (
    value.version !== 1 ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !Number.isSafeInteger(value.chatId) ||
    !Number.isSafeInteger(value.threadId) ||
    typeof value.nodeId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.nodeId) ||
    typeof value.operation !== "string" ||
    value.operation.length > 80 ||
    !Number.isSafeInteger(value.timestamp) ||
    Math.abs(now - value.timestamp) > 60_000 ||
    typeof value.nonce !== "string" ||
    !/^[A-Za-z0-9_-]{24,128}$/.test(value.nonce) ||
    (value.sessionId !== undefined &&
      (typeof value.sessionId !== "string" || value.sessionId.length > 256))
  )
    throw new Error("envelope_rejected");
  return value;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
