/* eslint-disable no-console -- this test intentionally captures Cloudflare structured diagnostics */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CloudTelegram } from "../src/cloudflare/telegram.js";

test("Telegram rejections expose only safe method/code diagnostics, never API descriptions or credentials", async () => {
  const messages: string[] = [];
  const previous = console.warn;
  console.warn = (message: string) => messages.push(message);
  try {
    const api = new CloudTelegram("synthetic-secret", async () =>
      Response.json(
        {
          ok: false,
          error_code: 400,
          description: "Bad Request: chat not found; synthetic-private-value",
        },
        { status: 400 },
      ),
    );
    await assert.rejects(
      api.call("sendMessage", { chat_id: 1, text: "synthetic-private-value" }),
      /telegram_rejected/,
    );
    assert.equal(messages.length, 1);
    const diagnostic = JSON.parse(messages[0]!);
    assert.equal(diagnostic.method, "sendMessage");
    assert.equal(diagnostic.apiCode, 400);
    assert.equal(diagnostic.reason, "chat_not_found");
    assert.equal(JSON.stringify(diagnostic).includes("synthetic-private-value"), false);
    assert.equal(JSON.stringify(diagnostic).includes("synthetic-secret"), false);
  } finally {
    console.warn = previous;
  }
});

test("document upload and download use Workers-compatible redirects and refuse credential forwarding", async () => {
  const api = new CloudTelegram("synthetic-secret", async (url, options) => {
    assert.equal(options?.redirect, "manual");
    return new Response(null, { status: 302, headers: { Location: "https://untrusted.example/" } });
  });
  await assert.rejects(api.document(1, 0, "file.txt", "fixture"), /telegram_ambiguous_redirect/);
});
