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
  let time=0;let provisionCalls=0;const calls:string[]=[];
  const lifecycle=new TopicNodeLifecycle({bindings,now:()=>time,wait:async delay=>{time+=delay;},snapshot:async()=>({revision:7,hash:'hash7'}),
    infrastructure:async(operation,nodeId,generation)=>{
      calls.push(operation);if(operation==='provision'){provisionCalls++;if(mode==='capacity')throw new Error('NO WORKER AVAILABLE / CAPACITY EXHAUSTED');}
      const result:ProvisionedNode={nodeId,generation,projectId:'workers',environmentId:'production',serviceId:'service-'+nodeId,volumeId:'volume-'+nodeId,endpoint:'https://worker.up.railway.app',phase:operation==='retire'?'retired':'deploying'};
      if(mode==='image-mismatch')Object.assign(result,{runtimeCommit:'a'.repeat(40),runtimeVersion:'1.18.33-bot.13-pre.17',image:'ghcr.io/example/core@sha256:'+'b'.repeat(64)});
      if(operation==='reconcile')assert.equal((await bindings.find(-100,2))?.status,'ready');
      return result;
    },
    node:async(binding,operation)=>{
      calls.push(operation);
      if(operation==='health')return {ok:true,result:{ready:mode!=='timeout',...(mode==='image-mismatch'?{runtime:{telegramCoreCommit:'c'.repeat(40),telegramCoreVersion:'1.18.33-bot.13-pre.17'}}:{})}};
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
test('retirement fences immediately, frees slot only after confirmed infrastructure cleanup',async()=>{
  const f=await fixture();const ready=await f.lifecycle.ensureReady(-100,2,'/logical/topic');
  assert.equal(await f.lifecycle.retire(-100,2),true);const retired=(await f.bindings.list())[0]!;assert.equal(retired.generation,ready.binding.generation+1);assert.equal(retired.status,'retired');assert.equal(await f.lifecycle.retire(-100,2),false);
});

test('image mismatch is rejected before snapshot activation and model/session creation',async()=>{
 const f=await fixture('image-mismatch');await assert.rejects(f.lifecycle.ensureReady(-100,2,'/topic'),/image.*mismatch/i);
 assert.equal(f.calls.includes('sync-global'),false);assert.equal(f.calls.includes('session.create'),false);
});
test('capacity failure never dispatches to any local or shared session',async()=>{
 const f=await fixture('capacity');await assert.rejects(f.lifecycle.ensureReady(-100,2,'/topic'),/CAPACITY EXHAUSTED/);
 assert.deepEqual(f.calls,['provision']);assert.equal((await f.bindings.find(-100,2))?.status,'failed');
});
