import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeBindingStore } from "../src/control-plane/node-bindings.js";
import { TopicNodeLifecycle } from "../src/control-plane/topic-node-lifecycle.js";
import type { ProvisionedNode } from "../src/infrastructure/node-provisioner.js";
async function fixture(mode='normal') {
  const bindings=new NodeBindingStore(path.join(await mkdtemp(path.join(tmpdir(),'lifecycle-')),'bindings.json'));
  let time=0;let provisionCalls=0;let healthCalls=0;const calls:string[]=[];
  const lifecycle=new TopicNodeLifecycle({bindings,now:()=>time,wait:async delay=>{time+=delay;},snapshot:async()=>({revision:7,hash:'hash7'}),
    infrastructure:async(operation,nodeId,generation)=>{
      calls.push(operation);if(mode==='recycle-failure'&&operation==='recycle')throw new Error('recycle failure');if(operation==='provision'){provisionCalls++;if(mode==='capacity')throw new Error('NO WORKER AVAILABLE / CAPACITY EXHAUSTED');if(mode==='overflow-capacity'&&(await bindings.list()).find(item=>item.nodeId===nodeId)?.slot===2)throw new Error('NO WORKER AVAILABLE / CAPACITY EXHAUSTED');}
      const result:ProvisionedNode={nodeId,generation,projectId:'workers',environmentId:'production',serviceId:'service-'+nodeId,volumeId:'volume-'+nodeId,endpoint:'https://worker.up.railway.app',phase:operation==='retire'?'retired':operation==='recycle'||operation==='rebind'?'recycled':'deploying'};
      if(mode==='image-mismatch')Object.assign(result,{runtimeCommit:'a'.repeat(40),runtimeVersion:'1.18.33-bot.13-pre.17',image:'ghcr.io/example/core@sha256:'+'b'.repeat(64)});
      if(operation==='reconcile'){const all=await bindings.list();assert.equal(all.some(item=>item.status==='ready'||item.status==='available'),true);}
      return result;
    },
    node:async(binding,operation)=>{
      calls.push(operation);
      if(operation==='health'){if(mode==='legacy-ready')return {ok:true,result:{ready:true}};healthCalls++;const readiness=mode==='timeout'?'warming':mode==='warming-once'&&healthCalls===1?'warming':binding.chatId===0?'ready-unbound':'ready';return {ok:true,result:{ready:readiness==='ready'||readiness==='ready-unbound',readiness,...(mode==='image-mismatch'?{runtime:{telegramCoreCommit:'c'.repeat(40),telegramCoreVersion:'1.18.33-bot.13-pre.17'}}:{})}};}
      if(operation==='sync-global')return {ok:true,result:{revision:7,hash:mode==='corrupt'?'wrong':'hash7'}};
      if(operation==='session.create')return {ok:true,result:{sessionId:'session'}};
      if(operation==='session.get'){assert.equal(binding.sessionId,'session');return {ok:true,result:{id:'session',title:'Worker session',directory:'/data/topic'}};}
      throw new Error('unsupported fake operation');
    }});
  return {lifecycle,bindings,calls,getProvisionCalls:()=>provisionCalls,getTime:()=>time};
}
test('Topic ready requires verified latest snapshot and owned session, duplicate creation singleflight',async()=>{
  const f=await fixture();const [one,two]=await Promise.all([f.lifecycle.ensureReady(-100,2,'/logical/topic'),f.lifecycle.ensureReady(-100,2,'/logical/topic')]);
  assert.deepEqual(one,two);assert.equal(f.getProvisionCalls(),1);assert.equal(one.binding.status,'ready');assert.equal(one.binding.currentRevision,7);assert.equal(one.session.directory,'/logical/topic');
  assert.ok(f.calls.indexOf('sync-global')<f.calls.indexOf('session.create'));assert.equal(f.calls.at(-1),'reconcile');
});
test('failed bootstrap retains failed durable reservation and cannot announce ready',async()=>{
  const f=await fixture('corrupt');await assert.rejects(f.lifecycle.ensureReady(-100,2,'/logical/topic'),/verification/);
  const binding=await f.bindings.find(-100,2);assert.equal(binding?.status,'failed');assert.equal(f.calls.includes('reconcile'),false);assert.equal(f.calls.includes('session.create'),false);
});
test('readiness retries are bounded on demand with no background loop',async()=>{
  const f=await fixture('timeout');await assert.rejects(f.lifecycle.ensureReady(-100,2,'/logical/topic'),/timed out/);assert.equal(f.getTime(),300000);
  const count=f.calls.length;await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.length,count);assert.equal((await f.bindings.find(-100,2))?.status,'failed');
});
test('Delete Chat recycles the same Worker into ready-unbound without deleting infrastructure',async()=>{
  const f=await fixture();const ready=await f.lifecycle.ensureReady(-100,2,'/logical/topic');
  assert.equal(await f.lifecycle.retire(-100,2),true);const recycled=(await f.bindings.list())[0]!;
  assert.equal(recycled.nodeId,ready.binding.nodeId);assert.equal(recycled.generation,ready.binding.generation+1);assert.equal(recycled.chatId,0);assert.equal(recycled.threadId,0);assert.equal(recycled.sessionId,undefined);assert.equal(recycled.status,'available');
  assert.equal(f.calls.includes('recycle'),true);assert.equal(f.calls.includes('retire'),false);assert.equal(await f.lifecycle.retire(-100,2),false);
});

test('Core readiness uses a fast adaptive first retry rather than a one-second polling floor',async()=>{
  const f=await fixture('warming-once');await f.lifecycle.ensureReady(-100,2,'/logical/topic');
  assert.ok(f.getTime()>0 && f.getTime()<=100,`expected <=100ms first readiness retry, got ${f.getTime()}`);
});

test('image mismatch is rejected before snapshot activation and model/session creation',async()=>{
 const f=await fixture('image-mismatch');await assert.rejects(f.lifecycle.ensureReady(-100,2,'/topic'),/image.*mismatch/i);
 assert.equal(f.calls.includes('sync-global'),false);assert.equal(f.calls.includes('session.create'),false);
});
test('capacity failure never dispatches to any local or shared session',async()=>{
 const f=await fixture('capacity');await assert.rejects(f.lifecycle.ensureReady(-100,2,'/topic'),/CAPACITY EXHAUSTED/);
 assert.deepEqual(f.calls,['provision']);assert.equal((await f.bindings.find(-100,2))?.status,'failed');
});

test('claiming an already prepared persistent Worker uses in-place rebind instead of Railway provisioning',async()=>{
 const bindings=new NodeBindingStore(path.join(await mkdtemp(path.join(tmpdir(),'rebind-claim-')),'bindings.json'));let slot=(await bindings.ensurePoolSlots(1))[0]!;
 slot=await bindings.update(slot.nodeId,1,{status:'available',endpoint:'https://worker.up.railway.app',projectId:'project',serviceId:'service',volumeId:'volume'});
 const operations:string[]=[];const lifecycle=new TopicNodeLifecycle({bindings,now:Date.now,wait:async()=>{},snapshot:async()=>({revision:1,hash:'h'}),
  infrastructure:async(operation,nodeId,generation)=>{operations.push(operation);return {nodeId,generation,projectId:'project',environmentId:'production',serviceId:'service',volumeId:'volume',endpoint:'https://worker.up.railway.app',phase:operation==='rebind'?'recycled':'deploying'};},
  node:async(binding,operation)=>{if(operation==='health')return {ok:true,result:{ready:true,readiness:'ready'}};if(operation==='sync-global')return {ok:true,result:{revision:1,hash:'h'}};if(operation==='session.create')return {ok:true,result:{sessionId:'s'}};if(operation==='session.get')return {ok:true,result:{id:'s',title:'S',directory:'/data/topic'}};throw new Error(operation);}});
 const ready=await lifecycle.ensureReady(-100,44,'/topic');assert.equal(ready.binding.nodeId,slot.nodeId);assert.equal(ready.binding.generation,2);assert.equal(operations.includes('rebind'),true);assert.equal(operations.includes('provision'),false);
});

test('an already ready Topic retry reads its owned session without creating another',async()=>{
 const f=await fixture();await f.lifecycle.ensureReady(-100,2,'/topic');
 await f.lifecycle.ensureReady(-100,2,'/topic');
 assert.equal(f.calls.filter(op=>op==='session.create').length,1);
});
test('New Chat preflight refuses an empty fleet before any Worker or session operation',async()=>{
 const f=await fixture();await assert.rejects(f.lifecycle.verifyAvailableWorker(),/CAPACITY EXHAUSTED/);
 assert.deepEqual(f.calls,[]);
});
test('New Chat preflight verifies the selected live Worker before returning it',async()=>{
 const f=await fixture();await f.lifecycle.bootstrapPool(1);f.calls.length=0;
 const worker=await f.lifecycle.verifyAvailableWorker();
 assert.equal(worker.status,'available');assert.equal(f.calls[0],'reconcile');
 assert.ok(f.calls.indexOf('reconcile')<f.calls.indexOf('inspect'));
 assert.equal(f.calls.includes('health'),true);assert.equal(f.calls.includes('session.create'),false);
});

test('New Chat reconciles an existing slot when no Worker is currently marked available',async()=>{
 const f=await fixture();await f.lifecycle.bootstrapPool(1);
 const [first]=await f.bindings.list();
 await f.bindings.update(first!.nodeId,first!.generation,{status:'pool-provisioning'});
 const worker=await f.lifecycle.verifyAvailableWorker();
 assert.equal(worker.nodeId,first!.nodeId);assert.equal(worker.status,'available');
 assert.equal((await f.bindings.list()).filter(item=>item.status==='available'&&item.chatId===0&&item.threadId===0).length,1);
});
test('failed recycle quarantines the Worker and never deletes its service or volume',async()=>{
 const f=await fixture('recycle-failure');await f.lifecycle.ensureReady(-100,2,'/topic');
 await assert.rejects(f.lifecycle.retire(-100,2),/recycle failure/);
 assert.equal(f.calls.includes('retire'),false);
 assert.equal((await f.bindings.list())[0]!.status,'retiring');
});

test('a legacy ready boolean without explicit bound readiness cannot admit a session',async()=>{
 const f=await fixture('legacy-ready');await assert.rejects(f.lifecycle.ensureReady(-100,2,'/topic'),/timed out/);
 assert.equal(f.calls.includes('session.create'),false);
});
