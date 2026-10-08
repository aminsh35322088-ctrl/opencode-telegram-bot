import assert from "node:assert/strict";
import { test } from "node:test";
import { CloudTelegram } from "../src/cloudflare/telegram.js";
import { telegramMediaParts } from "../src/cloudflare/media.js";

test("media downloads stay in the control boundary and send only inline bytes to Core", async () => {
  const seen: string[] = [];
  const telegram = new CloudTelegram("synthetic-secret", async (input) => {
    seen.push(String(input));
    if (String(input).includes("/getFile"))
      return Response.json({ ok: true, result: { file_path: "photos/image.jpg", file_size: 3 } });
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/jpeg" } });
  });
  const parts = await telegramMediaParts(telegram, {
    photo: [{ file_id: "id", file_size: 3 }],
    caption: "describe",
  });
  assert.deepEqual(parts, [
    { type: "text", text: "describe" },
    { type: "file", mime: "image/jpeg", filename: "image.jpg", url: "data:image/jpeg;base64,AQID" },
  ]);
  assert.equal(JSON.stringify(parts).includes("synthetic-secret"), false);
  assert.equal(seen.length, 2);
});
test("oversized and unsafe Telegram file responses fail before Core dispatch", async () => {
  const telegram = new CloudTelegram("synthetic", async () =>
    Response.json({ ok: true, result: { file_path: "../escape", file_size: 999999 } }),
  );
  await assert.rejects(
    telegramMediaParts(telegram, { document: { file_id: "id", file_size: 999999 } }),
    /media_too_large/,
  );
  const unsafe = new CloudTelegram("synthetic", async () =>
    Response.json({ ok: true, result: { file_path: "../escape", file_size: 1 } }),
  );
  await assert.rejects(
    telegramMediaParts(unsafe, { document: { file_id: "id" } }),
    /invalid_telegram_file/,
  );
});

test("generated workspace documents use Telegram multipart upload without token exposure", async () => {
  let payload: FormData | undefined;
  const telegram = new CloudTelegram("synthetic-secret", async (input, init) => {
    assert.match(String(input), /sendDocument$/);
    payload = init?.body as FormData;
    return Response.json({ ok: true, result: { message_id: 7 } });
  });
  await telegram.document(1, 42, "changes.diff", "patch data");
  assert.equal(payload?.get("chat_id"), "1");
  assert.equal(payload?.get("message_thread_id"), "42");
  const file = payload?.get("document") as File;
  assert.equal(await file.text(), "patch data");
  assert.equal(file.name, "changes.diff");
});
