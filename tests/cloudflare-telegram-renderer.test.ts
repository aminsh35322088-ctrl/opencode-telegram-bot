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
      ? Response.json({
          ok: false,
          error_code: 400,
          description: "Bad Request: unsupported rich message",
        })
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

test("unrelated Telegram rejections never trigger a second send", async () => {
  const calls: string[] = [];
  const telegram = new CloudTelegram("synthetic", async (url) => {
    calls.push(String(url).split("/").at(-1)!);
    return Response.json(
      { ok: false, error_code: 400, description: "Bad Request: message thread not found" },
      { status: 400 },
    );
  });
  await assert.rejects(telegram.send(-100, 42, "**hello**"));
  assert.deepEqual(calls, ["sendRichMessage"]);
});

test("entity parse rejection falls back once to formatted normal messages", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const telegram = new CloudTelegram("synthetic", async (url, init) => {
    calls.push({ method: String(url).split("/").at(-1)!, body: JSON.parse(String(init?.body)) });
    return calls.length === 1
      ? Response.json(
          {
            ok: false,
            error_code: 400,
            description: "Bad Request: can't parse entities: invalid entity",
          },
          { status: 400 },
        )
      : Response.json({ ok: true, result: { message_id: 7 } });
  });
  await telegram.send(-100, 42, "**سلام** `foo_bar`");
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.method, "sendMessage");
  assert.ok(calls[1]?.body.entities || calls[1]?.body.parse_mode === "HTML");
  assert.equal(
    calls[1]?.body.text === "سلام foo_bar" ||
      calls[1]?.body.text === "<b>سلام</b> <code>foo_bar</code>",
    true,
  );
});

test("format fallback is bounded and ambiguous sends never retry", async () => {
  let attempts = 0;
  const rejected = new CloudTelegram("synthetic", async () => {
    attempts++;
    return Response.json(
      { ok: false, error_code: 400, description: "Bad Request: can't parse entities" },
      { status: 400 },
    );
  });
  await assert.rejects(rejected.send(1, 42, "**hello**"));
  assert.equal(attempts, 3);
  attempts = 0;
  const ambiguous = new CloudTelegram("synthetic", async () => {
    attempts++;
    throw new Error("network");
  });
  await assert.rejects(ambiguous.send(1, 42, "**hello**"));
  assert.equal(attempts, 1);
});

test("long mixed Persian output has bounded independently formatted Unicode chunks", async () => {
  const { renderTelegramParts } = await import("../src/bot/render/pipeline.js");
  const source = "**می‌رود 👨‍💻 🧑🏽‍💻 🇮🇷 خانه‌ها**\n\n".repeat(300);
  const parts = renderTelegramParts(source);
  assert.ok(parts.length > 1);
  assert.equal(
    parts.every((p) => p.fallbackText.length <= 3800),
    true,
  );
  assert.equal(
    parts.every((p) =>
      p.entities?.every((e) => e.offset >= 0 && e.offset + e.length <= p.fallbackText.length),
    ),
    true,
  );
  assert.equal(
    parts.every((p) => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(p.fallbackText)),
    true,
  );
  assert.equal(
    parts.every((p) => !p.fallbackText.startsWith("\u200d") && !p.fallbackText.endsWith("\u200d")),
    true,
  );
  assert.equal(
    parts
      .map((p) => p.fallbackText)
      .join("")
      .replaceAll("\n", "")
      .includes("می‌رود"),
    true,
  );
});

test("summary compatibility preserves spoiler entity syntax", async () => {
  const { formatSummaryWithMode } =
    await import("../src/bot/messages/summary-message-formatter.js");
  assert.deepEqual(formatSummaryWithMode("||secret||", "markdown"), ["||secret||"]);
});

test("legacy rich transport refuses unrelated permission errors", async () => {
  const { sendRenderedBotPart } = await import("../src/bot/messages/telegram-text.js");
  let attempts = 0;
  const api = {
    sendRichMessage: async () => {
      attempts++;
      throw {
        error_code: 400,
        description: "Bad Request: not enough rights to send text messages",
      };
    },
    sendMessage: async () => {
      attempts++;
      return { message_id: 1 };
    },
  };
  await assert.rejects(
    sendRenderedBotPart({
      api: api as never,
      chatId: 1,
      part: {
        blocks: [{ type: "paragraph", text: "hello" }],
        fallbackText: "hello",
        source: "blocks",
      },
    }),
  );
  assert.equal(attempts, 1);
});

test("explicit native schema codes use the bounded Core entity fallback", async () => {
  for (const description of ["RICH_BLOCK_INVALID", "RICH_MESSAGE_BLOCK_UNSUPPORTED"]) {
    const methods: string[] = [];
    const telegram = new CloudTelegram("synthetic", async (url) => {
      methods.push(String(url).split("/").at(-1)!);
      return methods.length === 1
        ? Response.json({ ok: false, error_code: 400, description })
        : Response.json({ ok: true, result: { message_id: 17 } });
    });
    await telegram.send(1, 42, "**سلام** می‌تواند `foo_bar`");
    assert.deepEqual(methods, ["sendRichMessage", "sendMessage"]);
  }
});

test("production chunking keeps emoji whole when inline formatting changes inside it", async () => {
  const bodies: Record<string, unknown>[] = [];
  const telegram = new CloudTelegram("synthetic", async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    bodies.push(body);
    return body.rich_message
      ? Response.json({ ok: false, error_code: 400, description: "RICH_BLOCK_INVALID" })
      : Response.json({ ok: true, result: { message_id: bodies.length } });
  });
  await telegram.send(1, 42, "x".repeat(3798) + "**👨**‍💻 end");
  const textChunks = bodies
    .filter((body) => typeof body.text === "string")
    .map((body) => String(body.text));
  assert.equal(textChunks.join(""), "x".repeat(3798) + "👨‍💻 end");
  assert.ok(textChunks.some((text) => text.includes("👨‍💻")));
});
