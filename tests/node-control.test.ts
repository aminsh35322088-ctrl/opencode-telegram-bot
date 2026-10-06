import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeProtocol} from "../src/control-plane/node-protocol.js";
import {handleNodeControl} from "../src/control-plane/node-control.js";

test('minimal Worker bootstrap returns only exact canonical identity under provisional signed scope',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'node-bootstrap-'));
 const binding={nodeId:'slot',generation:2,chatId:-100,threadId:7,status:'provisioning',sessionId:undefined};
 const secret='synthetic-bootstrap-key'.repeat(4);const protocol=new NodeProtocol(join(dir,'replay.json'));
 const dependencies={protocol,resolveIdentity:async()=>({binding,secret}),dispatch:async()=>{assert.fail('bootstrap must not enter application or vault');}};
 const envelope={version:1 as const,nodeId:'slot',generation:2,chatId:0,threadId:0,operation:'bootstrap.get',payload:{},timestamp:Date.now(),nonce:'bootstrap_nonce_'.repeat(3)};
 const signed=protocol.sign(envelope,secret);
 const reply=await handleNodeControl(signed.body,signed.signature,dependencies);
 const response=JSON.parse(reply.body);assert.equal(response.chatId,0);assert.equal(response.threadId,0);assert.equal(response.nonce,envelope.nonce);assert.equal(response.sessionId,undefined);
 assert.deepEqual(response.payload,{ok:true,result:{nodeId:'slot',generation:2,chatId:-100,threadId:7}});
 assert.equal(protocol.sign(response,secret).signature,reply.signature);
 await assert.rejects(handleNodeControl(signed.body,signed.signature,dependencies),/replay/);
 for(const change of [{generation:1},{chatId:-100,threadId:7},{payload:{secret:true}},{sessionId:'foreign'}]){
  const bad=protocol.sign({...envelope,...change,nonce:'reject_'+String(Math.random()).replace('.','').padEnd(30,'x')},secret);
  await assert.rejects(handleNodeControl(bad.body,bad.signature,dependencies));
 }
 binding.status='retired';const retired=protocol.sign({...envelope,nonce:'retired_nonce_'.repeat(3)},secret);
 await assert.rejects(handleNodeControl(retired.body,retired.signature,dependencies));
});

test("control surface binds session and cannot dispatch arbitrary operations",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"node-control-"));
 const binding={nodeId:"node-1",generation:1,chatId:1,threadId:2,sessionId:"bound",status:"ready"};
 const secret="synthetic-control-secret".repeat(4);let calls=0;
 const protocol=new NodeProtocol(join(dir,"replay.json"));
 const dependencies={protocol,resolveIdentity:async()=>({binding,secret}),dispatch:async()=>{calls++;return {revision:1};}};
 const request=(operation:string,sessionId:string,nonce:string)=>protocol.sign({version:1,nodeId:binding.nodeId,generation:1,chatId:1,threadId:2,sessionId,operation,payload:{},timestamp:Date.now(),nonce},secret);
 try{
  const bad=request("mutation.commit","other","a".repeat(32));await assert.rejects(handleNodeControl(bad.body,bad.signature,dependencies),/session/);
  const forbidden=request("railway.delete","bound","b".repeat(32));await assert.rejects(handleNodeControl(forbidden.body,forbidden.signature,dependencies),/operation/);
  const good=request("snapshot.get","bound","c".repeat(32));const response=await handleNodeControl(good.body,good.signature,dependencies);
  assert.equal(JSON.parse(response.body).payload.revision,1);assert.equal(calls,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
