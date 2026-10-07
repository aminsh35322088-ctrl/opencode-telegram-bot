import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {captureNodeRegistry} from '../src/infrastructure/node-registry.js';
import {NodeProtocol,type NodeEnvelope} from '../src/control-plane/node-protocol.js';
import {InfrastructureNodeTransport} from '../src/infrastructure/node-transport.js';
async function fixture(t:{after(fn:()=>Promise<void>):void}){
 const dir=await mkdtemp(path.join(tmpdir(),'root-selftest-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const registry=captureNodeRegistry({});
 const identity={binding:{nodeId:'slot',generation:1,chatId:0,threadId:0,status:'available'},endpoint:'https://owned.up.railway.app',secret:'s'.repeat(64)};
 registry.install(identity);const server=new NodeProtocol(path.join(dir,'server.json'));const client=new NodeProtocol(path.join(dir,'client.json'));
 let calls=0;let alter=(reply:NodeEnvelope)=>reply;let after=async()=>{};let status=200;let signature='';let oversized=false;let captured:NodeEnvelope|undefined;let observed:RequestInit|undefined;let previous:{body:string;signature:string}|undefined;let replay=false;
 const fetcher=(async(_url:unknown,options:RequestInit)=>{
  calls++;observed=options;captured=await server.verify(String(options.body),(options.headers as Record<string,string>)['x-node-signature'],{nodeId:'slot',generation:1,chatId:0,threadId:0},identity.secret);
  const reply=alter({...captured,timestamp:Date.now(),nonce:'response_nonce_'+String(calls).padStart(20,'0'),payload:{ok:true,result:{profile:(captured.payload as {profile:string}).profile,joined:true,success:true,runId:'a'.repeat(48)}}});
  const signed=replay&&previous?previous:server.sign(reply,identity.secret);previous=signed;await after();
  return new Response(oversized?'x'.repeat(65537):signed.body,{status,headers:{'x-node-signature':signature||signed.signature}});
 }) as typeof fetch;
 const transport=new InfrastructureNodeTransport(registry,client,async()=>{throw Error('unexpected persistence');},fetcher,async()=>{throw Error('unexpected retry');});
 return {transport,registry,identity,client,server,dir,calls:()=>calls,request:()=>captured,options:()=>observed,alter:(fn:typeof alter)=>{alter=fn;},after:(fn:typeof after)=>{after=fn;},status:(code:number)=>{status=code;},signature:(s:string)=>{signature=s;},oversize:()=>{oversized=true;},replay:()=>{replay=true;}};
}
test('fixed profiles have signed unbound scope, fresh nonce and no session or arbitrary payload',async t=>{
 const f=await fixture(t);let nonce='';
 for(const profile of ['baseline','browser','network'] as const){
  const result=await f.transport.runtimeSelftest('slot',1,profile);
  assert.deepEqual(result,{profile,joined:true,success:true,runId:'a'.repeat(48)});
  assert.equal(f.request()?.operation,'runtime.selftest');assert.equal(f.request()?.sessionId,undefined);assert.deepEqual(f.request()?.payload,{profile});assert.notEqual(f.request()?.nonce,nonce);nonce=f.request()!.nonce;
  assert.equal(f.options()?.redirect,'error');assert.equal(f.options()?.signal?.aborted,false);
 }
 assert.equal(f.calls(),3);
});
test('generic request cannot reach the fixed selftest capability',async t=>{
 const f=await fixture(t);await assert.rejects(f.transport.request({version:1,nodeId:'slot',generation:1,chatId:0,threadId:0,operation:'runtime.selftest',payload:{profile:'baseline'},timestamp:Date.now(),nonce:'n'.repeat(24)}),/denied/);assert.equal(f.calls(),0);
});
test('bound, unavailable, session-bearing and stale-generation identities are denied before fetch',async t=>{
 const f=await fixture(t);await assert.rejects(f.transport.runtimeSelftest('slot',2,'baseline'),/scope/);
 for(const binding of [{...f.identity.binding,status:'provisioning'},{...f.identity.binding,chatId:1,threadId:2,status:'ready',sessionId:'foreign'}]){
  f.registry.install({...f.identity,binding});await assert.rejects(f.transport.runtimeSelftest('slot',1,'baseline'),/scope/);
 }
 f.registry.resolve=async()=>({...f.identity,binding:{...f.identity.binding,sessionId:'unexpected'}});
 await assert.rejects(f.transport.runtimeSelftest('slot',1,'baseline'),/scope/);assert.equal(f.calls(),0);
});
test('arbitrary runtime profile fails closed without traffic',async t=>{
 const f=await fixture(t);await assert.rejects(f.transport.runtimeSelftest('slot',1,'shell' as 'baseline'),/profile/);assert.equal(f.calls(),0);
});
test('ownership replacement while request runs denies even valid signed success',async t=>{
 const f=await fixture(t);f.after(async()=>f.registry.install({...f.identity,binding:{...f.identity.binding,generation:2}}));
 await assert.rejects(f.transport.runtimeSelftest('slot',1,'baseline'),/scope/);assert.equal(f.calls(),1);
});
test('same-generation Topic binding, signing identity change and session appearance deny response',async t=>{
 for(const mode of ['bound','secret','session']){
  const f=await fixture(t);f.after(async()=>{if(mode==='session')f.registry.resolve=async()=>({...f.identity,binding:{...f.identity.binding,sessionId:'late'}});else f.registry.install(mode==='secret'?{...f.identity,secret:'z'.repeat(64)}:{...f.identity,binding:{...f.identity.binding,chatId:1,threadId:2,status:'ready',sessionId:'late'}});});
  await assert.rejects(f.transport.runtimeSelftest('slot',1,'baseline'),/scope/);
 }
});
test('unsigned, stale, foreign and repeated responses cannot prove runtime success',async t=>{
 for(const mode of ['signature','timestamp','node','generation','replay']){
  const f=await fixture(t);
  if(mode==='signature')f.signature('0'.repeat(64));
  if(mode==='timestamp')f.alter(reply=>({...reply,timestamp:Date.now()-61000}));
  if(mode==='node')f.alter(reply=>({...reply,nodeId:'foreign'}));
  if(mode==='generation')f.alter(reply=>({...reply,generation:2}));
  if(mode==='replay'){await f.transport.runtimeSelftest('slot',1,'baseline');f.replay();}
  await assert.rejects(f.transport.runtimeSelftest('slot',1,'baseline'),/signature|timestamp|identity|replay/);
 }
});
test('response must have exact operation, profile, session absence, join/success booleans and48hex runId',async t=>{
 for(const patch of [{operation:'health'},{sessionId:'foreign'},{payload:{ok:false}},{payload:{ok:true,result:{profile:'network',joined:true,success:true,runId:'a'.repeat(48)}}},...['joined','success'].map(key=>({payload:{ok:true,result:{profile:'baseline',joined:true,success:true,runId:'a'.repeat(48),[key]:1}}})),...['', 'a'.repeat(47),'A'.repeat(48),'g'.repeat(48)].map(runId=>({payload:{ok:true,result:{profile:'baseline',joined:true,success:true,runId}}}))]){
  const f=await fixture(t);f.alter(reply=>({...reply,...patch}));await assert.rejects(f.transport.runtimeSelftest('slot',1,'baseline'),/proof|response/);
 }
});
test('response64KiB limit and transient HTTP errors are bounded and never retry',async t=>{
 for(const mode of ['size','503']){const f=await fixture(t);if(mode==='size')f.oversize();else f.status(503);await assert.rejects(f.transport.runtimeSelftest('slot',1,'baseline'),/large|failed/);assert.equal(f.calls(),1);}
});
test('total240s deadline covers registry lookup before traffic',async t=>{
 const f=await fixture(t);let release!:()=>void;f.registry.resolve=async()=>{await new Promise<void>(r=>{release=r;});return f.identity;};
 t.mock.timers.enable({apis:['setTimeout']});const result=f.transport.runtimeSelftest('slot',1,'baseline');const denied=assert.rejects(result,/deadline/);t.mock.timers.tick(240000);await denied;release();await Promise.resolve();assert.equal(f.calls(),0);
});
test('total deadline cancels a stalled64KiB reader and never accepts late completion',async t=>{
 const f=await fixture(t);let cancelled=0;let called=0;
 const transport=new InfrastructureNodeTransport(f.registry,f.client,async()=>{},(async()=>{called++;return new Response(new ReadableStream({cancel(){cancelled++;}}));}) as typeof fetch);
 t.mock.timers.enable({apis:['setTimeout']});const result=transport.runtimeSelftest('slot',1,'browser');const denied=assert.rejects(result,/deadline/);
 await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(called,1);t.mock.timers.tick(240000);await denied;await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(cancelled,1);
});
