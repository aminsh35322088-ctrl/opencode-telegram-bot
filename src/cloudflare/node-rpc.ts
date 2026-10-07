import { randomSecret } from "./credentials.js";
import { signEnvelope, verifyEnvelope } from "./protocol.js";
export interface RpcIdentity {
  workerId: string;
  generation: number;
  chatId: number;
  threadId: number;
  endpoint: string;
  secret: string;
}
export async function nodeRpc<T = unknown>(
  identity: RpcIdentity,
  operation: string,
  payload: unknown,
  sessionId?: string,
  transport: typeof fetch = fetch,
): Promise<T> {
  const target = new URL(identity.endpoint);
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    !target.hostname.endsWith(".up.railway.app")
  )
    throw new Error("invalid_worker_endpoint");
  const envelope = {
    version: 1 as const,
    nodeId: identity.workerId,
    generation: identity.generation,
    chatId: identity.chatId,
    threadId: identity.threadId,
    operation,
    payload,
    timestamp: Date.now(),
    nonce: randomSecret(),
    ...(sessionId ? { sessionId } : {}),
  };
  const signed = await signEnvelope(envelope, identity.secret);
  let response: Response;
  try {
    response = await transport(identity.endpoint + "/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-node-signature": signed.signature },
      body: signed.body,
      signal: AbortSignal.timeout(30_000),
      redirect: "manual",
    });
  } catch {
    throw new Error("worker_unavailable");
  }
  if (response.status >= 300 && response.status < 400) throw new Error("worker_redirect_rejected");
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 1024 * 1024) {
          await reader.cancel();
          throw new Error("worker_response_too_large");
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const raw = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.length;
  }
  const reply = await verifyEnvelope(
    new TextDecoder().decode(raw),
    response.headers.get("x-node-signature") ?? "",
    identity.secret,
  );
  if (
    reply.nodeId !== identity.workerId ||
    reply.generation !== identity.generation ||
    reply.chatId !== identity.chatId ||
    reply.threadId !== identity.threadId ||
    reply.sessionId !== sessionId ||
    reply.operation !== operation
  )
    throw new Error("stale_worker_response");
  const result = reply.payload as { ok?: boolean; result: T };
  if (!response.ok || result.ok !== true) throw new Error("worker_operation_rejected");
  return result.result;
}
