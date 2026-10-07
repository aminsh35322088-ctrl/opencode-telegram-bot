import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../src/cloudflare/worker.js";
import { signEnvelope, verifyEnvelope } from "../src/cloudflare/protocol.js";
test("Telegram ingress validates secret before persisting or enqueueing updates", async () => {
  let saved = 0;
  const env = {
    TELEGRAM_WEBHOOK_SECRET: "secret",
    CONTROL: {
      getByName: () => ({
        fetch: async () => {
          saved++;
          return Response.json({ ok: true });
        },
      }),
    },
  };
  const response = await worker.fetch(
    new Request("https://control.example/telegram/webhook", { method: "POST", body: "{}" }),
    env as never,
  );
  assert.equal(response.status, 401);
  assert.equal(saved, 0);
});
test("authorized webhook persists update then acknowledges without waiting for execution", async () => {
  let saved = 0;
  const env = {
    TELEGRAM_WEBHOOK_SECRET: "secret",
    CONTROL: {
      getByName: () => ({
        fetch: async () => {
          saved++;
          return Response.json({ ok: true });
        },
      }),
    },
  };
  const response = await worker.fetch(
    new Request("https://control.example/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" },
      body: JSON.stringify({ update_id: 12, message: { chat: { id: -100 }, text: "prompt" } }),
    }),
    env as never,
  );
  assert.equal(response.status, 200);
  assert.equal(saved, 1);
});
test("unsigned admin and node requests cannot reach durable state", async () => {
  let calls = 0;
  const env = {
    ADMIN_TOKEN: "admin",
    CONTROL: {
      getByName: () => ({
        fetch: async () => {
          calls++;
          return Response.json({ ok: true });
        },
      }),
    },
  };
  assert.equal(
    (
      await worker.fetch(
        new Request("https://control.example/admin/backends", { method: "POST", body: "{}" }),
        env as never,
      )
    ).status,
    401,
  );
  assert.equal(calls, 0);
});
test("WebCrypto transport preserves existing HMAC wire format and rejects altered bodies", async () => {
  const envelope = {
    version: 1 as const,
    nodeId: "worker",
    generation: 1,
    chatId: -100,
    threadId: 42,
    operation: "health",
    payload: {},
    timestamp: 1000,
    nonce: "a".repeat(48),
  };
  const signed = await signEnvelope(envelope, "s".repeat(64));
  const verified = await verifyEnvelope(signed.body, signed.signature, "s".repeat(64), 1000);
  assert.deepEqual(verified, envelope);
  await assert.rejects(verifyEnvelope(signed.body + " ", signed.signature, "s".repeat(64), 1000));
  await assert.rejects(verifyEnvelope(signed.body, signed.signature, "s".repeat(64), 70001));
});
test("chunked oversized public node body is rejected before durable state dispatch", async () => {
  let calls = 0;
  const env = {
    CONTROL: {
      getByName: () => ({
        fetch: async () => {
          calls++;
          return Response.json({ ok: true });
        },
      }),
    },
  };
  let chunks = 0;
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(512 * 1024));
      if (++chunks === 20) controller.close();
    },
  });
  const response = await worker.fetch(
    new Request("https://control.example/nodes/events", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit),
    env as never,
  );
  assert.equal(response.status, 413);
  assert.equal(calls, 0);
  assert.ok(chunks < 20);
});
