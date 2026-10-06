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
test('four unbound slots bootstrap idempotently and allocation claims only available slots',async()=>{
 const filename=path.join(await mkdtemp(path.join(tmpdir(),'node-pool-')),'bindings.json');const store=new NodeBindingStore(filename);
 const slots=await store.ensurePoolSlots();assert.equal(slots.length,4);
 assert.deepEqual((await new NodeBindingStore(filename).ensurePoolSlots()).map(n=>n.nodeId),slots.map(n=>n.nodeId));
 await assert.rejects(store.reserve(-100,2),/ready/);
 for(const n of slots)await store.update(n.nodeId,n.generation,{status:'available',endpoint:'https://worker.up.railway.app'});
 const claims=await Promise.allSettled(Array.from({length:5},(_,i)=>store.reserve(-100,i+2)));
 assert.equal(claims.filter(n=>n.status==='fulfilled').length,4);
 const active=await store.list();assert.equal(new Set(active.map(n=>n.nodeId)).size,4);assert.ok(active.every(n=>n.generation===2));
 assert.equal(await store.find(0,0),undefined);
});

test('unbound slot cleanup can persist and restart its fence without becoming a Topic',async()=>{
 const store=new NodeBindingStore(path.join(await mkdtemp(path.join(tmpdir(),'unbound-fence-')),'bindings.json'));
 const slot=(await store.ensurePoolSlots())[0]!;await store.fence(slot.nodeId,1);
 const fenced=(await store.list()).find(item=>item.nodeId===slot.nodeId)!;
 assert.equal(fenced.status,'retiring');assert.equal(fenced.generation,2);assert.equal(fenced.chatId,0);assert.equal(fenced.threadId,0);
 assert.deepEqual(await store.fence(slot.nodeId,1),fenced);
 await assert.rejects(store.reserve(0,2),/Telegram Topic/);
});

test('unbound slots reject session ownership and ready Topic status before writing state',async()=>{
 const store=new NodeBindingStore(path.join(await mkdtemp(path.join(tmpdir(),'unbound-state-')),'bindings.json'));
 const slot=(await store.ensurePoolSlots())[0]!;
 await assert.rejects(store.update(slot.nodeId,1,{status:'ready',endpoint:'https://worker.up.railway.app'}),/bound Telegram Topic/);
 await assert.rejects(store.update(slot.nodeId,1,{sessionId:'invented'}),/session/);
 assert.equal((await store.list())[0]!.status,'pool-reserved');assert.equal((await store.list())[0]!.sessionId,undefined);
});
