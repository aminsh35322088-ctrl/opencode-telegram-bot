import assert from "node:assert/strict";
import { test } from "node:test";
import { nodeRpc } from "../src/cloudflare/node-rpc.js";
import { signEnvelope } from "../src/cloudflare/protocol.js";
test("node RPC checks exact worker, Topic and session response authority", async () => {
  const identity = {
    workerId: "worker",
    generation: 3,
    chatId: -100,
    threadId: 42,
    endpoint: "https://worker.up.railway.app",
    secret: "s".repeat(64),
  };
  const transport = async (_input: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    const reply = await signEnvelope(
      { ...request, nonce: "x".repeat(48), payload: { ok: true, result: { ready: true } } },
      identity.secret,
    );
    return new Response(reply.body, { headers: { "x-node-signature": reply.signature } });
  };
  assert.deepEqual(await nodeRpc(identity, "health", {}, undefined, transport as typeof fetch), {
    ready: true,
  });
  await assert.rejects(
    nodeRpc(identity, "health", {}, undefined, (async () => {
      const reply = await signEnvelope(
        {
          version: 1,
          nodeId: "worker",
          generation: 2,
          chatId: -100,
          threadId: 42,
          operation: "health",
          payload: { ok: true, result: {} },
          nonce: "x".repeat(48),
          timestamp: Date.now(),
        },
        identity.secret,
      );
      return new Response(reply.body, { headers: { "x-node-signature": reply.signature } });
    }) as typeof fetch),
    /stale_worker_response/,
  );
});
