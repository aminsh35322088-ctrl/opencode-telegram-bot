import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {NodeProtocol} from '../src/control-plane/node-protocol.js';
import {handleNodeControl} from '../src/control-plane/node-control.js';
import {captureNodeRegistry} from '../src/infrastructure/node-registry.js';
import {InfrastructureNodeTransport} from '../src/infrastructure/node-transport.js';

async function fixture(){
 const home=await mkdtemp(path.join(tmpdir(),'unbound-root-'));const protocol=new NodeProtocol(path.join(home,'replay.json'));
 const identity={binding:{nodeId:'slot',generation:1,chatId:0,threadId:0,status:'available'},endpoint:'https://worker.up.railway.app',secret:'s'.repeat(64)};
 const registry=captureNodeRegistry({CONTROL_NODE_REGISTRY:JSON.stringify([identity])});
 return {identity,protocol,registry};
}

test('unbound Root control allows only authenticated snapshot bootstrap and denies credentials and mutations',async()=>{
 const {identity,protocol}=await fixture();const operations:string[]=[];
 const dependencies={protocol,resolveIdentity:async()=>identity,dispatch:async(envelope:{operation:string})=>{operations.push(envelope.operation);return {revision:1};}};
 for(const operation of ['snapshot.get','credential.get','mutation.prepare','mutation.commit']){
  const request=protocol.sign({version:1,...identity.binding,operation,payload:{},timestamp:Date.now(),nonce:operation.replaceAll('.','').padEnd(32,'a')},identity.secret);
  if(operation==='snapshot.get')await handleNodeControl(request.body,request.signature,dependencies);
  else await assert.rejects(handleNodeControl(request.body,request.signature,dependencies),/Unbound|unbound/);
 }
 assert.deepEqual(operations,['snapshot.get']);
});

test('unbound Bot transport never sends session or execution RPCs while Root retirement requires explicit joined proof',async()=>{
 const {identity,protocol,registry}=await fixture();let proof:unknown={ok:true};let fetches=0;
 const transport=new InfrastructureNodeTransport(registry,protocol,async()=>{},async(_url,options)=>{
  fetches++;const request=JSON.parse(options!.body as string);
  const signed=protocol.sign({...request,nonce:'reply'+String(fetches).padStart(27,'a'),timestamp:Date.now(),payload:proof},identity.secret);
  return new Response(signed.body,{status:200,headers:{'x-node-signature':signed.signature}});
 });
 for(const operation of ['session.create','run','question.reply','retire']){
  await assert.rejects(transport.request({version:1,...identity.binding,operation,payload:{},timestamp:Date.now(),nonce:'a'.repeat(32)}),/Unbound/);
 }
 assert.equal(fetches,0);
 registry.install({...identity,binding:{...identity.binding,generation:2,status:'retired'}});
 await assert.rejects(transport.retireFenced(identity),/denied/);
 proof={ok:true,result:{retired:false}};await assert.rejects(transport.retireFenced(identity),/denied/);
 proof={ok:true,result:{retired:true}};await transport.retireFenced(identity);
});

test('Root in-place rotation sanitizes old generation and verifies binding.rotate with the previous secret',async()=>{
 const home=await mkdtemp(path.join(tmpdir(),'rotation-root-'));const protocol=new NodeProtocol(path.join(home,'replay.json'));
 const identity={binding:{nodeId:'slot',generation:7,chatId:-100,threadId:22,sessionId:'session',status:'ready'},endpoint:'https://worker.up.railway.app',secret:'s'.repeat(64)};
 const registry=captureNodeRegistry({CONTROL_NODE_REGISTRY:JSON.stringify([identity])});const target={nodeId:'slot',generation:8,chatId:0,threadId:0};const seen:string[]=[];
 const transport=new InfrastructureNodeTransport(registry,protocol,async()=>{},async(_url,options)=>{
  const request=JSON.parse(options!.body as string) as {operation:string;payload:unknown;sessionId?:string;nonce:string};seen.push(request.operation);
  if(request.operation==='retire'){assert.deepEqual(request.payload,{sanitize:true});assert.equal(request.sessionId,'session');const reply=protocol.sign({...request,nonce:'retire-reply-'.padEnd(32,'a'),timestamp:Date.now(),payload:{ok:true,result:{retired:true,sanitized:true}}},identity.secret);return new Response(reply.body,{status:200,headers:{'x-node-signature':reply.signature}});}
  assert.equal(request.operation,'binding.rotate');assert.equal(request.sessionId,undefined);assert.deepEqual(request.payload,{bootstrapToken:'b'.repeat(64)});const reply=protocol.sign({...request,nonce:'rotate-reply-'.padEnd(32,'a'),timestamp:Date.now(),payload:{ok:true,result:{rotated:true,identity:target}}},identity.secret);return new Response(reply.body,{status:200,headers:{'x-node-signature':reply.signature}});
 });
 await transport.retireFenced(identity,true);await transport.rotateFenced(identity,'b'.repeat(64),target);assert.deepEqual(seen,['retire','binding.rotate']);
});


test('bound Root transport admits Worker-supported provider catalog and permission reads with exact session scope',async()=>{
 const home=await mkdtemp(path.join(tmpdir(),'bound-root-'));const protocol=new NodeProtocol(path.join(home,'replay.json'));
 const identity={binding:{nodeId:'slot',generation:3,chatId:-100,threadId:77,sessionId:'owned',status:'ready'},endpoint:'https://worker.up.railway.app',secret:'s'.repeat(64)};
 const registry=captureNodeRegistry({CONTROL_NODE_REGISTRY:JSON.stringify([identity])});const seen:string[]=[];
 const transport=new InfrastructureNodeTransport(registry,protocol,async()=>{},async(_url,options)=>{
  const request=JSON.parse(options!.body as string);seen.push(request.operation);const result=request.operation==='models.list'?{providers:[]}:[];
  const reply=protocol.sign({...request,nonce:`reply-${seen.length}`.padEnd(32,'a'),timestamp:Date.now(),payload:{ok:true,result}},identity.secret);return new Response(reply.body,{status:200,headers:{'x-node-signature':reply.signature}});
 });
 for(const operation of ['models.list','permission.list','session.compact']){const result=await transport.request({version:1,...identity.binding,operation,payload:{},timestamp:Date.now(),nonce:operation.replaceAll('.','').padEnd(32,'a')});assert.equal((result as {ok?:boolean}).ok,true);}
 assert.deepEqual(seen,['models.list','permission.list','session.compact']);
});
