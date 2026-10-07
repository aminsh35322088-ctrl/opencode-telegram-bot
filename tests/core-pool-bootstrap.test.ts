import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Api} from 'grammy';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {NodeBindingStore} from '../src/control-plane/node-bindings.js';
import {createRemoteTopicSession,TopicNodeLifecycle} from '../src/control-plane/topic-node-lifecycle.js';
import type {ProvisionedNode} from '../src/infrastructure/node-provisioner.js';

async function fixture() {
  const bindings=new NodeBindingStore(path.join(await mkdtemp(path.join(tmpdir(),'pool-bootstrap-')),'bindings.json'));
  let time=0;let failSlot:number|undefined;let timeout=false;let corrupt=false;
  const provisioned:number[]=[];const reconciled:number[]=[];const operations:string[]=[];
  const failure=new Error('Root provisioning detail');
  await bindings.ensurePoolSlots(4);
  const lifecycle=new TopicNodeLifecycle({bindings,now:()=>time,wait:async delay=>{time+=delay;},snapshot:async()=>({revision:7,hash:'hash7'}),
    infrastructure:async(operation,nodeId,generation)=>{
      const binding=(await bindings.list()).find(item=>item.nodeId===nodeId)!;
      assert.equal(binding.chatId,0);assert.equal(binding.threadId,0);assert.equal(generation,1);
      if(operation==='provision'){
        assert.equal(binding.status,'pool-provisioning');provisioned.push(binding.slot!);
        if(binding.slot===failSlot)throw failure;
      }else if(operation==='reconcile'){
        assert.equal(binding.status,'available');reconciled.push(binding.slot!);
      }else assert.fail('bootstrap must not retire Workers');
      return {nodeId,generation,projectId:'workers',environmentId:'production',serviceId:'service-'+nodeId,volumeId:'volume-'+nodeId,endpoint:'https://worker.up.railway.app',phase:'deploying'} as ProvisionedNode;
    },node:async(binding,operation)=>{
      assert.equal(binding.chatId,0);assert.equal(binding.threadId,0);assert.equal(binding.sessionId,undefined);
      operations.push(operation);
      if(operation==='health')return {ok:true,result:{ready:!timeout}};
      if(operation==='sync-global')return {ok:true,result:{revision:7,hash:corrupt?'wrong':'hash7'}};
      assert.fail('unbound bootstrap must not request '+operation);
    }});
  return {bindings,lifecycle,provisioned,reconciled,operations,failure,setFail:(slot?:number)=>{failSlot=slot;},setTimeout:()=>{timeout=true;},setCorrupt:()=>{corrupt=true;},now:()=>time};
}

test('bootstrap creates exactly four unbound ready Workers and repeated/concurrent calls preserve identity',async()=>{
  const f=await fixture();const first=f.lifecycle.bootstrapPool();assert.equal(first,f.lifecycle.bootstrapPool());
  const slots=await first;assert.deepEqual(f.provisioned,[1,2,3,4]);assert.deepEqual(f.reconciled,[1,2,3,4]);
  assert.equal(slots.length,4);assert.ok(slots.every(item=>item.status==='available'&&item.chatId===0&&item.threadId===0&&item.generation===1&&item.currentRevision===7&&!item.sessionId));
  const again=await f.lifecycle.bootstrapPool();assert.deepEqual(again,slots);assert.deepEqual(f.provisioned,[1,2,3,4]);
  assert.deepEqual(new Set(f.operations),new Set(['health','sync-global']));
});

test('failure preserves earlier ready slots and retries only incomplete persistent reservations',async()=>{
  const f=await fixture();f.setFail(3);await assert.rejects(f.lifecycle.bootstrapPool(),error=>error===f.failure);
  const before=await f.bindings.list();assert.deepEqual(before.map(item=>item.status),['available','available','pool-provisioning','pool-reserved']);
  assert.deepEqual(f.provisioned,[1,2,3]);f.setFail();await f.lifecycle.bootstrapPool();
  assert.deepEqual(f.provisioned,[1,2,3,3,4]);const after=await f.bindings.list();
  assert.deepEqual(after.map(item=>item.nodeId),before.map(item=>item.nodeId));assert.equal(after[0]!.serviceId,before[0]!.serviceId);
});

test('unready bootstrap has finite readiness deadline and retains provisioned resources without idle retries',async()=>{
  const f=await fixture();f.setTimeout();await assert.rejects(f.lifecycle.bootstrapPool(),/timed out/);assert.equal(f.now(),300000);
  const slot=(await f.bindings.list())[0]!;assert.equal(slot.status,'pool-provisioning');assert.ok(slot.serviceId&&slot.volumeId&&slot.endpoint);
  const count=f.operations.length;await new Promise(resolve=>setImmediate(resolve));assert.equal(f.operations.length,count);assert.deepEqual(f.provisioned,[1]);
});

test('unbound Worker becomes available only after exact global snapshot verification',async()=>{
  const f=await fixture();f.setCorrupt();await assert.rejects(f.lifecycle.bootstrapPool(),/verification/);
  assert.equal((await f.bindings.list())[0]!.status,'pool-provisioning');assert.deepEqual(f.reconciled,[]);
});

test('explicit reconciliation withdraws cached availability on corrupt sync and preserves resource ownership',async()=>{
 const f=await fixture();const before=await f.lifecycle.bootstrapPool();f.setCorrupt();
 await assert.rejects(f.lifecycle.bootstrapPool(),/verification/);
 const after=await f.bindings.list();assert.equal(after[0]!.status,'pool-provisioning');
 assert.equal(after[0]!.nodeId,before[0]!.nodeId);assert.equal(after[0]!.serviceId,before[0]!.serviceId);assert.equal(after[0]!.volumeId,before[0]!.volumeId);assert.equal(after[0]!.currentRevision,7);
 assert.deepEqual(f.provisioned,[1,2,3,4]);assert.equal(after.slice(1).every(binding=>binding.status==='available'),true);
});

test('claiming reuses prepared Workers then reserves lazy capacity',async()=>{
  const f=await fixture();await f.bindings.ensurePoolSlots(4);
  await f.lifecycle.bootstrapPool();
  const claimed=[];for(let thread=2;thread<6;thread++)claimed.push(await f.bindings.reserve(-100,thread));
  assert.ok(claimed.every(item=>item.generation===2&&item.status==='reserved'));assert.equal((await f.bindings.reserve(-100,6)).generation,1);
  await f.lifecycle.bootstrapPool();assert.deepEqual(f.provisioned,[1,2,3,4]);assert.equal((await f.bindings.list()).length,5);
});


test('New Chat reaches Telegram creation regardless of historical warm pool capacity',async()=>{
 let creations=0;const reachedCreate=new Error('Telegram creation reached');
 const api={raw:{createForumTopic:async()=>{creations++;throw reachedCreate;}}} as unknown as Api;
 await assert.rejects(createRemoteTopicSession(api,-100,'/topic'),error=>error===reachedCreate);
 assert.equal(creations,1);
});

test('administrative warm capacity can exceed four without changing default lazy allocation',async()=>{
 const f=await fixture();const slots=await f.lifecycle.bootstrapPool(5);
 assert.equal(slots.length,5);assert.deepEqual(f.provisioned,[1,2,3,4,5]);
});
