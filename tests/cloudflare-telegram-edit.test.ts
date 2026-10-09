import assert from "node:assert/strict";
import { test } from "node:test";
import { CloudTelegram, TelegramDeliveryError } from "../src/cloudflare/telegram.js";
function telegram(description: string, code = 400) {
  return new CloudTelegram("synthetic", async () =>
    Response.json({ ok: false, error_code: code, description }, { status: code }),
  );
}
test("identical panel and Topic edits are successful idempotent retries", async () => {
  const t = telegram(
    "Bad Request: message is not modified: specified new message content and reply markup are exactly the same",
  );
  assert.deepEqual(await t.call("editMessageText", { message_id: 42 }), { message_id: 42 });
  assert.deepEqual(await t.call("editMessageReplyMarkup", { message_id: 42 }), { message_id: 42 });
  assert.equal(await telegram("Bad Request: TOPIC_NOT_MODIFIED").call("editForumTopic", {}), true);
});
test("only definite missing edit target permits recreating a panel", async () => {
  await assert.rejects(
    telegram("Bad Request: message to edit not found").call("editMessageText", {}),
    (e: unknown) => e instanceof TelegramDeliveryError && e.reason === "message_not_found",
  );
  await assert.rejects(
    telegram("Bad Request: message can't be edited").call("editMessageText", {}),
    (e: unknown) => e instanceof TelegramDeliveryError && !e.reason,
  );
  await assert.rejects(
    telegram("Unauthorized", 401).call("editMessageText", {}),
    (e: unknown) => e instanceof TelegramDeliveryError && !e.reason,
  );
});

test("final streamed edit uses existing native rich blocks and Persian RTL", async () => {
  const { renderTelegramParts } = await import("../src/bot/render/pipeline.js");
  let received: any;
  const t = new CloudTelegram("synthetic", async (input, init) => {
    received = { method: String(input).split("/").at(-1), payload: JSON.parse(String(init?.body)) };
    return Response.json({ ok: true, result: { message_id: 42 } });
  });
  const part = renderTelegramParts("**پاسخ فارسی**")[0]!;
  assert.equal(await t.editPart(1, 42, part), 42);
  assert.equal(received.method, "editMessageText");
  assert.equal(received.payload.message_id, 42);
  assert.deepEqual(received.payload.rich_message.blocks, part.blocks);
  assert.equal(received.payload.rich_message.is_rtl, true);
});
