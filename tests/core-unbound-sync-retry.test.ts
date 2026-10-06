import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {captureNodeRegistry} from '../src/infrastructure/node-registry.js';
import {NodeProtocol} from '../src/control-plane/node-protocol.js';
import {InfrastructureNodeTransport} from '../src/infrastructure/node-transport.js';
const secret='a'.repeat(64);
async function fixture(status:number,corrupt=false){
 const registry=captureNodeRegistry({});const binding={nodeId:'node',generation:1,chatId:0,threadId:0,status:'available'};
 registry.install({binding,endpoint:'https://worker.up.railway.app',secret});const protocol=new NodeProtocol(path.join(await mkdtemp(path.join(tmpdir(),'sync-retry-')),'replay.json'));
 let calls=0;let waitHook=async()=>{};const waits:number[]=[];const nonces:string[]=[];
 const transport=new InfrastructureNodeTransport(registry,protocol,async()=>{},(async(_url,input)=>{
  calls++;const request=JSON.parse(String(input?.body));nonces.push(request.nonce);
  const reply=protocol.sign({...request,timestamp:Date.now(),nonce:'response_nonce_'+calls+'_'.repeat(16),payload:calls===1?{ok:false,error:'operation rejected'}:{ok:true,result:{revision:0,hash:'hash0'}}},secret);
  return new Response(reply.body,{status:calls===1?status:200,headers:{'x-node-signature':corrupt?'0'.repeat(64):reply.signature}});
 }) as typeof fetch,async ms=>{waits.push(ms);await waitHook();});
 const envelope={version:1 as const,nodeId:'node',generation:1,chatId:0,threadId:0,operation:'sync-global',payload:{revision:0},timestamp:Date.now(),nonce:'input_nonce_'.repeat(4)};
 return {transport,envelope,waits,nonces,registry,setWait:(hook:()=>Promise<void>)=>{waitHook=hook;},calls:()=>calls};
}
test('unbound snapshot sync retries a signed transient rejection once with fresh nonce',async()=>{
 const f=await fixture(409);assert.deepEqual(await f.transport.request(f.envelope),{ok:true,result:{revision:0,hash:'hash0'}});assert.equal(f.calls(),2);assert.deepEqual(f.waits,[2000]);assert.notEqual(f.nonces[0],f.nonces[1]);
});
test('unbound proxy failures retry while authentication and invalid signatures fail immediately',async()=>{
 for(const status of [502,503,504]){const f=await fixture(status);await f.transport.request(f.envelope);assert.equal(f.calls(),2);}
 for(const status of [401,403]){const f=await fixture(status);await assert.rejects(f.transport.request(f.envelope));assert.equal(f.calls(),1);}
 const f=await fixture(409,true);await assert.rejects(f.transport.request(f.envelope));assert.equal(f.calls(),1);
});
test('ordinary operations are never automatically retried',async()=>{
 const f=await fixture(503);await assert.rejects(f.transport.request({...f.envelope,operation:'health'}));assert.equal(f.calls(),1);
});

test('retry remains fenced when identity changes during backoff',async()=>{
 const f=await fixture(503);
 let entered!:()=>void;let resume!:()=>void;
 const waiting=new Promise<void>(resolve=>{entered=resolve;});
 const release=new Promise<void>(resolve=>{resume=resolve;});
 f.setWait(async()=>{entered();await release;});
 const request=f.transport.request(f.envelope);await waiting;
 const identity=await f.registry.resolve('node');
 f.registry.install({...identity!,binding:{...identity!.binding,generation:2}});resume();
 await assert.rejects(request,/identity/);assert.equal(f.calls(),1);
});
