import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeProtocol} from "../src/control-plane/node-protocol.js";
import {handleNodeControl} from "../src/control-plane/node-control.js";

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
