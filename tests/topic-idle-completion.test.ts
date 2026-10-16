import assert from "node:assert/strict";
import {test,afterEach} from "node:test";
import type {Event} from "@opencode-ai/sdk/v2";
import {summaryAggregator} from "../src/app/managers/summary-aggregation-manager.js";
import {runInTopicRuntimeContext} from "../src/app/services/topic-runtime-context.js";

const topic={chatId:42,threadId:7,sessionId:"owned",directory:"/topic/owned"};
const emit=(type:string,sessionID:string,status?:string)=>summaryAggregator.processEvent({type,properties:{sessionID,...(status?{status:{type:status}}:{})}} as Event);
afterEach(()=>summaryAggregator.clear());

test("Worker terminal idle status releases the Topic without waiting for a second event",async()=>{
 const completed:string[]=[];
 summaryAggregator.setSession(topic.sessionId);
 summaryAggregator.beginRun(topic.sessionId);
 summaryAggregator.setOnSessionIdle(async sessionId=>{completed.push(sessionId);});
 await runInTopicRuntimeContext(topic,async()=>{
  emit("session.status","owned","busy");
  emit("session.status","owned","idle");
  await new Promise(resolve=>setImmediate(resolve));
 });
 assert.deepEqual(completed,["owned"]);
});

test("duplicate idle event finalizes once and the next run can finalize independently",async()=>{
 const completed:string[]=[];
 summaryAggregator.setSession(topic.sessionId);
 summaryAggregator.setOnSessionIdle(async sessionId=>{completed.push(sessionId);});
 await runInTopicRuntimeContext(topic,async()=>{
  summaryAggregator.beginRun("owned");
  emit("session.status","owned","busy");
  emit("session.status","owned","idle");
  emit("session.idle","owned");
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(completed,["owned"]);
  summaryAggregator.beginRun("owned");
  emit("session.status","owned","busy");
  emit("session.status","owned","idle");
  await new Promise(resolve=>setImmediate(resolve));
 });
 assert.deepEqual(completed,["owned","owned"]);
});

test("busy retry and foreign idle statuses cannot release an owned run",async()=>{
 const completed:string[]=[];
 summaryAggregator.setSession(topic.sessionId);
 summaryAggregator.beginRun(topic.sessionId);
 summaryAggregator.setOnSessionIdle(async sessionId=>{completed.push(sessionId);});
 await runInTopicRuntimeContext(topic,async()=>{
  emit("session.status","owned","busy");
  emit("session.status","owned","retry");
  emit("session.status","foreign","idle");
  await new Promise(resolve=>setImmediate(resolve));
 });
 assert.deepEqual(completed,[]);
});
