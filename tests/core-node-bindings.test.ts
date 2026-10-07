import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeBindingStore } from "../src/control-plane/node-bindings.js";

test("concurrent allocations reserve durable unique identities", async () => {
  const filename = path.join(await mkdtemp(path.join(tmpdir(), "node-bindings-")), "bindings.json");
  const store = new NodeBindingStore(filename);
  const result = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => store.reserve(-100, index + 2)));
  assert.equal(result.filter((entry) => entry.status === "fulfilled").length, 5);
  const bindings = await new NodeBindingStore(filename).list();
  assert.equal(new Set(bindings.map((entry) => entry.nodeId)).size, 5);
  assert.equal((await store.reserve(-100,6)).nodeId,bindings[4]?.nodeId);
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
 const slots=await store.ensurePoolSlots(4);assert.equal(slots.length,4);
 assert.deepEqual((await new NodeBindingStore(filename).ensurePoolSlots(4)).map(n=>n.nodeId),slots.map(n=>n.nodeId));
 for(const n of slots)await store.update(n.nodeId,n.generation,{status:'available',endpoint:'https://worker.up.railway.app'});
 const claims=await Promise.allSettled(Array.from({length:5},(_,i)=>store.reserve(-100,i+2)));
 assert.equal(claims.filter(n=>n.status==='fulfilled').length,5);
 const active=await store.list();assert.equal(new Set(active.map(n=>n.nodeId)).size,5);assert.ok(active.filter(n=>n.slot).every(n=>n.generation===2));
 assert.equal(await store.find(0,0),undefined);
});

test('unbound slot cleanup can persist and restart its fence without becoming a Topic',async()=>{
 const store=new NodeBindingStore(path.join(await mkdtemp(path.join(tmpdir(),'unbound-fence-')),'bindings.json'));
 const slot=(await store.ensurePoolSlots(4))[0]!;await store.fence(slot.nodeId,1);
 const fenced=(await store.list()).find(item=>item.nodeId===slot.nodeId)!;
 assert.equal(fenced.status,'retiring');assert.equal(fenced.generation,2);assert.equal(fenced.chatId,0);assert.equal(fenced.threadId,0);
 assert.deepEqual(await store.fence(slot.nodeId,1),fenced);
 await assert.rejects(store.reserve(0,2),/Telegram Topic/);
});

test('unbound slots reject session ownership and ready Topic status before writing state',async()=>{
 const store=new NodeBindingStore(path.join(await mkdtemp(path.join(tmpdir(),'unbound-state-')),'bindings.json'));
 const slot=(await store.ensurePoolSlots(4))[0]!;
 await assert.rejects(store.update(slot.nodeId,1,{status:'ready',endpoint:'https://worker.up.railway.app'}),/bound Telegram Topic/);
 await assert.rejects(store.update(slot.nodeId,1,{sessionId:'invented'}),/session/);
 assert.equal((await store.list())[0]!.status,'pool-reserved');assert.equal((await store.list())[0]!.sessionId,undefined);
});

test('lazy allocations exceed historical four and duplicate New Chat reservation is stable',async()=>{
 const filename=path.join(await mkdtemp(path.join(tmpdir(),'dynamic-bindings-')),'bindings.json');
 const store=new NodeBindingStore(filename);
 await store.ensurePoolSlots(0);
 const nodes=await Promise.all(Array.from({length:7},(_,i)=>store.reserve(-100,i+2)));
 assert.equal(new Set(nodes.map(n=>n.nodeId)).size,7);
 const duplicates=await Promise.all(Array.from({length:12},()=>store.reserve(-100,2)));
 assert.ok(duplicates.every(n=>n.nodeId===nodes[0]!.nodeId));
 assert.equal((await new NodeBindingStore(filename).list()).length,7);
});
test('a verified free Worker is claimed before a lazy reservation is created',async()=>{
 const store=new NodeBindingStore(path.join(await mkdtemp(path.join(tmpdir(),'reuse-bindings-')),'bindings.json'));
 const [free]=await store.ensurePoolSlots(1);
 await store.update(free!.nodeId,1,{status:'available',endpoint:'https://worker.up.railway.app'});
 const claimed=await store.reserve(-100,2);assert.equal(claimed.nodeId,free!.nodeId);assert.equal(claimed.generation,2);
 const lazy=await store.reserve(-100,3);assert.notEqual(lazy.nodeId,claimed.nodeId);assert.equal((await store.list()).length,2);
});
