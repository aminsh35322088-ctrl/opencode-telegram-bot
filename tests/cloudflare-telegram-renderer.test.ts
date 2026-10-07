import assert from "node:assert/strict";
import { test } from "node:test";
import { CloudTelegram } from "../src/cloudflare/telegram.js";
test("Cloudflare renderer preserves native rich blocks and Persian RTL", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const telegram = new CloudTelegram("synthetic", async (url, options) => {
    calls.push({ method: String(url).split("/").at(-1)!, body: JSON.parse(String(options?.body)) });
    return Response.json({ ok: true, result: { message_id: 1 } });
  });
  await telegram.send(-100, 42, "**سلام** دنیا");
  assert.equal(calls[0]!.method, "sendRichMessage");
  assert.equal((calls[0]!.body.rich_message as { is_rtl: boolean }).is_rtl, true);
  assert.equal(calls[0]!.body.message_thread_id, 42);
});
test("unsupported rich Telegram API falls back to the same source-preserving text", async () => {
  let attempts = 0;
  const bodies: Record<string, unknown>[] = [];
  const telegram = new CloudTelegram("synthetic", async (_url, options) => {
    bodies.push(JSON.parse(String(options?.body)));
    return ++attempts === 1
      ? Response.json({ ok: false, error_code: 400 })
      : Response.json({ ok: true, result: { message_id: 1 } });
  });
  await telegram.send(-100, 42, "hello");
  assert.equal(bodies[1]!.text, "hello");
  assert.equal(bodies[1]!.message_thread_id, 42);
});

test("native fetch transport is invoked without a CloudTelegram receiver", async () => {
  const client = new CloudTelegram("synthetic", async function (this: unknown, _url, _init) {
    assert.equal(this, undefined);
    return Response.json({ ok: true, result: { id: 7 } });
  });
  assert.deepEqual(await client.call("getMe", {}), { id: 7 });
});
