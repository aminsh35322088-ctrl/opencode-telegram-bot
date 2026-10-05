import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeBindingStore } from "../src/control-plane/node-bindings.js";

test("concurrent allocations reserve exactly four durable unique slots", async () => {
  const filename = path.join(await mkdtemp(path.join(tmpdir(), "node-bindings-")), "bindings.json");
  const store = new NodeBindingStore(filename);
  const result = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => store.reserve(-100, index + 2)));
  assert.equal(result.filter((entry) => entry.status === "fulfilled").length, 4);
  const bindings = await new NodeBindingStore(filename).list();
  assert.equal(new Set(bindings.map((entry) => entry.nodeId)).size, 4);
  await assert.rejects(store.reserve(-100, 6), /Maximum/);
  assert.equal((await store.reserve(-100, 2)).nodeId, bindings[0]?.nodeId);
  assert.equal((await readFile(filename, "utf8")).includes("secret"), false);
});
test("delete fences immediately, retries idempotently, and holds allocation until cleanup", async () => {
  const store = new NodeBindingStore(path.join(await mkdtemp(path.join(tmpdir(), "node-fence-")), "bindings.json"));
  const node = await store.reserve(-100, 2);
  const fenced = await store.fence(node.nodeId, node.generation);
  assert.equal(fenced.generation, 2);
  assert.deepEqual(await store.fence(node.nodeId, node.generation), fenced);
  await assert.rejects(store.update(node.nodeId, 1, { status: "ready", endpoint: "https://example.test" }), /Stale/);
  await store.update(node.nodeId, 2, { status: "retired" });
  assert.equal(await store.find(-100, 2), undefined);
  assert.notEqual((await store.reserve(-100, 2)).nodeId, node.nodeId);
});
test("node metadata rejects plaintext transport and revision rollback", async () => {
  const store = new NodeBindingStore(path.join(await mkdtemp(path.join(tmpdir(), "node-limits-")), "bindings.json"));
  await assert.rejects(store.reserve(-100, 0), /Telegram Topic/);
  await assert.rejects(store.reserve(-100, 1), /Telegram Topic/);
  const node = await store.reserve(-100, 2);
  await assert.rejects(store.update(node.nodeId, 1, { endpoint: "http://example.test" }), /HTTPS/);
  await store.update(node.nodeId, 1, { currentRevision: 5 });
  await assert.rejects(store.update(node.nodeId, 1, { currentRevision: 4 }), /regress/);
});
