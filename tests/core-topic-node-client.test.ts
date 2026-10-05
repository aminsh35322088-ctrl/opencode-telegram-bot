import assert from "node:assert/strict";
import { test } from "node:test";
import { TopicNodeClient, installSecureNodeTransport } from "../src/control-plane/topic-node-client.js";
import type { NodeBinding } from "../src/control-plane/node-bindings.js";
import type { NodeEnvelope } from "../src/control-plane/node-protocol.js";
const binding: NodeBinding = { nodeId: "node", generation: 3, chatId: -100, threadId: 2, sessionId: "session", currentRevision: 1, status: "ready", createdAt: "now", updatedAt: "now" };
let mode = "request";
let fence = false;
installSecureNodeTransport({
  async request(_binding, envelope) {
    assert.equal(envelope.nodeId, "node"); assert.equal(envelope.generation, 3); assert.equal(envelope.sessionId, "session");
    assert.match(envelope.nonce, /^[a-zA-Z0-9_-]{24,128}$/);
    if (mode === "fence") fence = true;
    return { ok: true, result: { accepted: true } };
  },
  async *stream(_binding, envelope) {
    yield { ...envelope, generation: mode === "foreign" ? 2 : 3, operation: "session.event", payload: { runId: "run", event: "hello" } } satisfies NodeEnvelope;
  },
});
const client = new TopicNodeClient(binding, async () => { if (fence) throw new Error("stale generation"); });
test("native response rejected if node replaced during in-flight request", async () => {
  mode = "fence";
  await assert.rejects(client.request("status"), /stale/);
  fence = false;
});
test("stream rejects foreign generation before delivery", async () => {
  mode = "foreign";
  await assert.rejects(async () => { for await (const _event of client.events("run")) assert.fail("foreign event delivered"); }, /Stale or foreign/);
});
test("valid run event delivers after current binding check", async () => {
  mode = "request";
  const events: unknown[] = [];
  for await (const event of client.events("run")) events.push(event);
  assert.deepEqual(events, ["hello"]);
});
