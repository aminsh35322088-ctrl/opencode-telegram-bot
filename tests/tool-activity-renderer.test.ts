import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToolActivity } from "../src/bot/streaming/tool-activity-renderer.js";

test("tool activity renders as one collapsed native Details block with redacted fallback", () => {
  const rendered = renderToolActivity(
    "💻 Shell · TOKEN=super-secret\n\n🔎 Grep · Authorization: Bearer abc.def.ghi\n\n✏️ Edit · src/index.ts",
  );

  assert.equal(rendered.source, "blocks");
  assert.equal(rendered.blocks.length, 1);
  const block = rendered.blocks[0];
  assert.equal(block?.type, "details");
  if (!block || block.type !== "details") throw new Error("expected native details block");
  assert.equal(block.is_open, undefined);
  assert.equal(JSON.stringify(block.summary), '"🛠 Activity"');
  assert.match(JSON.stringify(block.blocks), /Shell/);
  assert.match(JSON.stringify(block.blocks), /Grep/);
  assert.match(JSON.stringify(block.blocks), /Edit/);
  assert.doesNotMatch(JSON.stringify(block), /super-secret|abc\.def\.ghi/);
  assert.match(JSON.stringify(block), /REDACTED/);

  assert.match(rendered.fallbackText, /^🛠 Activity/);
  assert.match(rendered.fallbackText, /Shell/);
  assert.doesNotMatch(rendered.fallbackText, /super-secret|abc\.def\.ghi/);
  assert.match(rendered.fallbackText, /REDACTED/);
});


test("tool activity redacts quoted JSON and environment credential assignments", () => {
  const rendered = renderToolActivity(`curl -d '{"api_key":"SENSITIVE_JSON","nested":{"password": "PRIVATE_JSON"}}' TOKEN=ENV_SECRET`);
  for (const output of [rendered.fallbackText, JSON.stringify(rendered.blocks)]) {
    assert.doesNotMatch(output, /SENSITIVE_JSON|PRIVATE_JSON|ENV_SECRET/);
    assert.match(output, /REDACTED/);
  }
});
