import assert from "node:assert/strict";
import { test } from "node:test";
import { nodeBindings, type NodeBinding } from "../src/control-plane/node-bindings.js";
import { installSecureNodeTransport } from "../src/control-plane/topic-node-client.js";
import { getRemoteRunId, invokeTopicSdk, recoverRemoteTopicRun } from "../src/control-plane/topic-sdk-adapter.js";
import { stopTopicEventBus } from "../src/opencode/topic-event-bus.js";
const binding:NodeBinding={nodeId:'recovery-node',generation:4,chatId:-100,threadId:2,sessionId:'owned',currentRevision:2,status:'ready',createdAt:'now',updatedAt:'now'};
nodeBindings.find=async()=>structuredClone(binding);
let mode='active'; const calls:Array<{operation:string;payload:unknown}>=[]; let statusCalls=0;
installSecureNodeTransport({request:async(_binding,envelope)=>{
  calls.push({operation:envelope.operation,payload:envelope.payload});
  if(envelope.operation==='status') {
    statusCalls++;
    if(mode==='idle')return {ok:true,result:null};
    if(mode==='bad')return {ok:true,result:{continuation:'live',externalRunId:'bad run id'}};
    return {ok:true,result:{continuation:'live',externalRunId:mode==='race'&&statusCalls>1?'replacement-run':'durable-run'}};
  }
  return {ok:true,result:true};
},stream:async function*(_binding,_envelope,options){
  options?.onReady?.();
  await new Promise<void>(resolve=>{if(options?.signal?.aborted)resolve();else options?.signal?.addEventListener('abort',()=>resolve(),{once:true});});
}});
const topic={chatId:-100,threadId:2,sessionId:'owned',directory:'/logical/topic'};
test('restart Stop recovers exact signed active run before sending control',async()=>{
  assert.equal(getRemoteRunId('owned'),undefined);
  await invokeTopicSdk(topic,'session.abort',[{sessionID:'owned'}]);
  assert.deepEqual(calls.at(-1),{operation:'stop',payload:{runId:'durable-run'}});
});
test('Question reply reconnects existing execution without prepare or new model run',async()=>{
  calls.length=0;statusCalls=0;mode='active';
  try {
    await invokeTopicSdk(topic,'question.reply',[{requestID:'question',answers:[['Yes']]}]);
    assert.deepEqual(calls.at(-1),{operation:'question.reply',payload:{runId:'durable-run',requestId:'question',answers:[['Yes']]}});
    assert.equal(calls.some(call=>call.operation==='run.prepare'||call.operation==='run'),false);
  }finally{stopTopicEventBus();await new Promise(resolve=>setImmediate(resolve));}
});
test('idle recovery opens no stream and drops stale in-memory run',async()=>{
  mode='idle';calls.length=0;
  assert.equal(await recoverRemoteTopicRun(topic,true),null);assert.equal(getRemoteRunId('owned'),undefined);
  assert.deepEqual(calls.map(call=>call.operation),['status']);
});
test('invalid or replaced signed run fails before Question control',async()=>{
  mode='bad';await assert.rejects(recoverRemoteTopicRun(topic),/exact run identity/);
  mode='race';statusCalls=0;calls.length=0;
  await assert.rejects(invokeTopicSdk(topic,'question.reply',[{requestID:'question',answers:[['Yes']]}]),/cannot be recovered/);
  assert.equal(calls.some(call=>call.operation==='question.reply'||call.operation==='run.prepare'),false);
  stopTopicEventBus();
});
