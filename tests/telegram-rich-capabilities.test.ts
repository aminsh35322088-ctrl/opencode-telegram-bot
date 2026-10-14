import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMarkdownDocument, renderTelegramRichDocument } from "@opencode-telegram/native-runtime";
import { renderTelegramParts } from "../src/bot/render/pipeline.js";

function serialized(markdown: string): string {
  return JSON.stringify(renderTelegramParts(markdown));
}

test("Bot final-answer pipeline preserves Core-owned Details, math, date/time and references", () => {
  const output = serialized([
    "Main answer stays visible.",
    "",
    "<details><summary>Technical details</summary>",
    "Inside details with `code`.",
    "</details>",
    "",
    "<tg-math>x^2 + y^2</tg-math>",
    "",
    "<tg-time unix=1760457600 format=r>deployment time</tg-time>",
    "",
    "See note[^proof].",
    "",
    "[^proof]: Evidence",
  ].join("\n"));

  assert.match(output, /Main answer stays visible/);
  assert.match(output, /\"type\":\"details\"/);
  assert.match(output, /Technical details/);
  assert.match(output, /\"type\":\"mathematical_expression\"/);
  assert.match(output, /\"type\":\"date_time\"/);
  assert.match(output, /\"type\":\"reference_link\"/);
  assert.match(output, /\"type\":\"reference\"/);
});

test("model-authored interactive buttons stay disabled while visible text survives", () => {
  const output = serialized(
    '<tg-button type="callback_data" data="dangerous">Visible button label</tg-button>',
  );

  assert.match(output, /Visible button label/);
  assert.doesNotMatch(output, /\"callback_data\":\"dangerous\"/);
  assert.doesNotMatch(output, /\"type\":\"button\"/);
});

test("ordinary currency is not promoted to math and Bot preserves Core-owned table compactness", () => {
  const markdown = [
    "Price is $100, not an equation.",
    "",
    "| File | State |",
    "| --- | --- |",
    "| core | ready |",
  ].join("\n");
  const output = serialized(markdown);
  const coreBlocks = renderTelegramRichDocument(parseMarkdownDocument(markdown), { draft: false }).blocks ?? [];
  const coreTable = coreBlocks.find((block) => block.type === "table");
  const botTable = renderTelegramParts(markdown).flatMap((part) => part.blocks).find((block) => block.type === "table");

  assert.match(output, /\$100/);
  assert.doesNotMatch(output, /\"expression\":\"100\"/);
  assert.match(output, /\"type\":\"table\"/);
  assert.ok(coreTable && coreTable.type === "table");
  assert.ok(botTable && botTable.type === "table");
  assert.equal(botTable.is_compact, coreTable.is_compact);
});
