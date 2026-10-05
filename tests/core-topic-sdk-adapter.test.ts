import assert from "node:assert/strict";
import { test } from "node:test";
import { nodeBindings, type NodeBinding } from "../src/control-plane/node-bindings.js";
import { installSecureNodeTransport } from "../src/control-plane/topic-node-client.js";
import { invokeTopicSdk } from "../src/control-plane/topic-sdk-adapter.js";
const binding:NodeBinding={nodeId:'adapter-node',generation:1,chatId:-100,threadId:1,sessionId:'owned',currentRevision:2,status:'ready',createdAt:'now',updatedAt:'now'};
nodeBindings.find=async()=>structuredClone(binding);
const calls:string[]=[];
installSecureNodeTransport({request:async (_binding,envelope)=>{
  calls.push(envelope.operation);
  if(envelope.operation==='session.get')return {ok:true,result:{id:'owned',directory:'/data/topic'}};
  return {ok:true,result:{}};
}});
const topic={chatId:-100,threadId:1,sessionId:'owned',directory:'/logical/topic-one'};
test('remote native session metadata preserves Bot logical Topic directory',async()=>{
  const response=await invokeTopicSdk(topic,'session.get',[{sessionID:'owned',directory:topic.directory}]);
  assert.deepEqual(response,{handled:true,result:{data:{id:'owned',directory:topic.directory}}});
});
test('foreign sessions and unsupported raw SDK operations fail before transport',async()=>{
  const before=calls.length;
  await assert.rejects(invokeTopicSdk(topic,'session.get',[{sessionID:'foreign'}]),/does not belong/);
  await assert.rejects(invokeTopicSdk(topic,'provider.list',[]),/unsupported/);
  await assert.rejects(invokeTopicSdk(topic,'session.create',[{parentID:'owned'}]),/Worker Core/);
  assert.equal(calls.length,before);
});
test('unbound Topic retains legacy dispatch without remote fallback for bound Topic',async()=>{
  const original=nodeBindings.find;nodeBindings.find=async()=>undefined;
  try {assert.deepEqual(await invokeTopicSdk(topic,'session.get',[]),{handled:false});} finally {nodeBindings.find=original;}
});
