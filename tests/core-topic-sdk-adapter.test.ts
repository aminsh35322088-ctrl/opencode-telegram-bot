import assert from "node:assert/strict";
import { test } from "node:test";
import { nodeBindings, type NodeBinding } from "../src/control-plane/node-bindings.js";
import { installSecureNodeTransport } from "../src/control-plane/topic-node-client.js";
import { buildRemoteCompactionPayload, classifyRemoteCompactionEvent, invokeTopicSdk } from "../src/control-plane/topic-sdk-adapter.js";
const binding:NodeBinding={nodeId:'adapter-node',generation:1,chatId:-100,threadId:2,sessionId:'owned',currentRevision:2,status:'ready',createdAt:'now',updatedAt:'now'};
nodeBindings.find=async()=>structuredClone(binding);
nodeBindings.list=async()=>[];
const calls:Array<{operation:string;payload:unknown}>=[];
installSecureNodeTransport({request:async (_binding,envelope)=>{
  calls.push({operation:envelope.operation,payload:envelope.payload});
  if(envelope.operation==='session.get')return {ok:true,result:{id:'owned',directory:'/data/topic'}};
  if(envelope.operation==='models.list')return {ok:true,result:{providers:[{id:'opencode',name:'OpenCode',models:{}}]}};
  if(envelope.operation==='agents.list')return {ok:true,result:[{name:'build',mode:'primary'}]};
  if(envelope.operation==='permission.list')return {ok:true,result:[{id:'perm',sessionID:'owned'}]};
  return {ok:true,result:{}};
}});
const topic={chatId:-100,threadId:2,sessionId:'owned',directory:'/logical/topic-one'};
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

test('retired remote Topics never fall back to the local Core',async()=>{
 const original=nodeBindings.find;nodeBindings.find=async()=>undefined;nodeBindings.list=async()=>[{...binding,status:'retired'}];
 try{await assert.rejects(invokeTopicSdk(topic,'session.get',[]),/Retired/);}finally{nodeBindings.find=original;nodeBindings.list=async()=>[];}
});

test('remote Topic routes provider catalog and pending permission reads through owned Worker RPC',async()=>{
 const catalog=await invokeTopicSdk(topic,'config.providers',[{}]);assert.deepEqual(catalog,{handled:true,result:{data:{providers:[{id:'opencode',name:'OpenCode',models:{}}]}}});
 const agents=await invokeTopicSdk(topic,'app.agents',[{directory:topic.directory}]);assert.deepEqual(agents,{handled:true,result:{data:[{name:'build',mode:'primary'}]}});
 const permissions=await invokeTopicSdk(topic,'permission.list',[{directory:topic.directory}]);assert.deepEqual(permissions,{handled:true,result:{data:[{id:'perm',sessionID:'owned'}]}});
 assert.deepEqual(calls.slice(-3),[{operation:'models.list',payload:{}},{operation:'agents.list',payload:{}},{operation:'permission.list',payload:{}}]);
});


test('remote compaction payload and terminal events preserve synchronous SDK semantics',()=>{
 const payload=buildRemoteCompactionPayload('run_123',{providerID:'opencode',modelID:'big-pickle'});
 assert.deepEqual(payload,{runId:'run_123',model:{providerID:'opencode',modelID:'big-pickle'},events:true});
 assert.throws(()=>buildRemoteCompactionPayload('',{providerID:'opencode',modelID:'big-pickle'}),/run identity/);
 assert.deepEqual(classifyRemoteCompactionEvent({type:'session.compacted',properties:{sessionID:'owned'}}),{state:'completed'});
 assert.deepEqual(classifyRemoteCompactionEvent({type:'session.error',properties:{message:'provider failed'}}),{state:'failed',message:'provider failed'});
 assert.equal(classifyRemoteCompactionEvent({type:'message.part.updated',properties:{}}),null);
});


test('remote compaction success requires the exact session in its terminal event',()=>{
 assert.equal(classifyRemoteCompactionEvent({type:'session.compacted',properties:{}},'owned'),null);
 assert.equal(classifyRemoteCompactionEvent({type:'session.compacted',properties:{sessionID:'foreign'}},'owned'),null);
 assert.deepEqual(classifyRemoteCompactionEvent({type:'session.compacted',properties:{sessionID:'owned'}},'owned'),{state:'completed'});
});
