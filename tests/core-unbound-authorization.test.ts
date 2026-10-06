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
