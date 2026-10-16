import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {captureNodeRegistry} from '../src/infrastructure/node-registry.js';
import {NodeProtocol,type NodeEnvelope} from '../src/control-plane/node-protocol.js';
import {InfrastructureNodeTransport,WorkerBoundaryVerificationError} from '../src/infrastructure/node-transport.js';

async function fixture(acceptReplay=false, interruption?:{call:number;status:number}){
 const dir=await mkdtemp(path.join(tmpdir(),'node-proof-'));
 const registry=captureNodeRegistry({});
 const identity={binding:{nodeId:'slot',generation:1,chatId:0,threadId:0,status:'available'},endpoint:'https://owned.up.railway.app',secret:'s'.repeat(64)};
 registry.install(identity);
 const server=new NodeProtocol(path.join(dir,'server.json'));
 let calls=0;
 const fetcher=(async(_url:unknown,options:RequestInit)=>{
  calls++;
  if(interruption?.call===calls){if(interruption.status===0)throw new TypeError("fetch failed");return new Response("",{status:interruption.status});}
  const body=String(options.body);
  const signature=(options.headers as Record<string,string>)['x-node-signature'];
  let request:NodeEnvelope;
  try{request=await server.verify(body,signature,{nodeId:'slot',generation:1,chatId:0,threadId:0},identity.secret);}
  catch(error){if(!acceptReplay||!(error instanceof Error)||!error.message.includes('replay'))return new Response('{}',{status:401});request=JSON.parse(body);}
  const signed=server.sign({...request,nonce:'response_nonce_'+String(calls).padStart(20,'0'),payload:{ok:true,result:{ready:true}}},identity.secret);
  return new Response(signed.body,{headers:{'x-node-signature':signed.signature}});
 }) as typeof fetch;
 const transport=new InfrastructureNodeTransport(registry,new NodeProtocol(path.join(dir,'client.json')),async()=>{},fetcher);
 return {transport,calls:()=>calls,registry};
}
test('unbound root probe proves real replay and identity rejection with bounded signed requests',async()=>{
 const f=await fixture();
 assert.deepEqual(await f.transport.probeUnboundBoundary('slot',1),{health:true,replayRejected:true,foreignTopicRejected:true,staleGenerationRejected:true});
 assert.equal(f.calls(),4);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls(),4);
});
test('root probe fails closed if a server accepts a replay',async()=>{
 const f=await fixture(true);
 await assert.rejects(f.transport.probeUnboundBoundary('slot',1),error=>error instanceof WorkerBoundaryVerificationError&&error.check==='replay'&&error.status===200);
 assert.equal(f.calls(),2);
});
test('root probe cannot target a bound Topic or superseded generation',async()=>{
 const f=await fixture();
 await assert.rejects(f.transport.probeUnboundBoundary('slot',2),/scope/);
 f.registry.install({binding:{nodeId:'slot',generation:1,chatId:1,threadId:2,status:'ready',sessionId:'private'},endpoint:'https://owned.up.railway.app',secret:'s'.repeat(64)});
 await assert.rejects(f.transport.probeUnboundBoundary('slot',1),/scope/);
 assert.equal(f.calls(),0);
});

test('startup proxy and network failures retry without accepting incomplete boundary proofs',async()=>{
 const {WorkerProvisioningError}=await import('../src/infrastructure/worker-provisioning-driver.js');
 for(const call of [1,2,3,4])for(const status of [0,404,429,502,503,504]){
  const f=await fixture(false,{call,status});
  await assert.rejects(f.transport.probeUnboundBoundary('slot',1),error=>error instanceof WorkerProvisioningError&&error.category==='provisioning_pending');
  assert.deepEqual(await f.transport.probeUnboundBoundary('slot',1),{health:true,replayRejected:true,foreignTopicRejected:true,staleGenerationRejected:true});
 }
});
