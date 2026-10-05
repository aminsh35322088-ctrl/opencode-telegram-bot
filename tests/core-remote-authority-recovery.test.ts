import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { Api } from "grammy";
import { RailwayResourceGovernor } from "@opencode-telegram/native-runtime";
import { initializeNativeCore, shutdownNativeCore, getNativeCore, restoreRemoteCoreRun, finishCoreRunForSession, coreBindingId } from "../src/core/native-core-service.js";
import { runInTopicRuntimeContext } from "../src/app/services/topic-runtime-context.js";
import { createCoreSessionApi } from "../src/bot/services/core-session-api.js";
import { deleteTelegramTopicSession } from "../src/app/services/telegram-topic-delete-service.js";
import { nodeBindings, type NodeBinding } from "../src/control-plane/node-bindings.js";
import { topicNodeLifecycle } from "../src/control-plane/topic-node-lifecycle.js";
// Deterministic synthetic fixtures only; never inherit production Telegram credentials.
process.env.TELEGRAM_BOT_TOKEN="12345:synthetic-authority-test";
process.env.TELEGRAM_ALLOWED_USER_ID="12345";
mock.method(RailwayResourceGovernor,"currentSnapshot",(workerCount:number,idleWorkerCount:number)=>({rssBytes:32*1024*1024,totalBytes:32*1024*1024,workerCount,idleWorkerCount}));
const topic={chatId:-100,threadId:2,sessionId:'owned',directory:'/logical/topic'};
const node:NodeBinding={nodeId:'authority-node',generation:1,...topic,currentRevision:1,status:'ready',createdAt:'now',updatedAt:'now'};
nodeBindings.find=async()=>node;nodeBindings.list=async()=>[node];
test('signed recovery restores exact logical RunIdentity without model dispatch',async()=>{
  process.env.OPENCODE_TELEGRAM_HOME=await mkdtemp(path.join(tmpdir(),'remote-authority-'));
  try {
    await initializeNativeCore({} as Api,[topic]);
    const run=await runInTopicRuntimeContext(topic,()=>restoreRemoteCoreRun('owned',topic.directory,'remote-run'));
    assert.equal(run.runId,'remote-run');assert.equal(getNativeCore()!.runs.current(run.bindingId)?.runId,'remote-run');
    assert.deepEqual(await runInTopicRuntimeContext(topic,()=>restoreRemoteCoreRun('owned',topic.directory,'remote-run')),run);
    await assert.rejects(runInTopicRuntimeContext(topic,()=>restoreRemoteCoreRun('owned',topic.directory,'other-run')),/differs/);
    await assert.rejects(runInTopicRuntimeContext({...topic,threadId:3},()=>restoreRemoteCoreRun('owned',topic.directory,'remote-run')),/exact Topic/);
    assert.equal(finishCoreRunForSession('owned'),true);
  }finally{await shutdownNativeCore();delete process.env.OPENCODE_TELEGRAM_HOME;}
});
test('Delete durably fences captured Telegram output before awaiting infrastructure; failed cleanup stays fenced on retry',async()=>{
  process.env.OPENCODE_TELEGRAM_HOME=await mkdtemp(path.join(tmpdir(),'remote-delete-fence-'));
  let infrastructureStarted!:()=>void;let rejectRetirement!:(reason:Error)=>void;
  let started=new Promise<void>(resolve=>{infrastructureStarted=resolve;});
  const original=topicNodeLifecycle.retire;
  topicNodeLifecycle.retire=async()=>{infrastructureStarted();return new Promise<boolean>((_resolve,reject)=>{rejectRetirement=reject;});};
  const sent:string[]=[];const api={sendMessage:async(_chat:number,text:string)=>{sent.push(text);},raw:{sendMessage:async(input:{text:string})=>{sent.push(input.text);}}} as unknown as Api;
  const binding={...topic,createdAt:'now',updatedAt:'now'};
  try {
    await initializeNativeCore(api,[topic]);const captured=createCoreSessionApi(api,'owned');
    await captured.sendMessage(-100,'before');
    const capturedRaw=captured.raw.sendMessage;
    assert.throws(()=>capturedRaw({chat_id:-200,text:'foreign'}),/chat differs/);
    const deleting=deleteTelegramTopicSession(api,binding);const failure=assert.rejects(deleting,/synthetic retirement unavailable/);
    await started;
    assert.throws(()=>captured.sendMessage(-100,'late'),/Core Topic binding changed/);
    assert.throws(()=>capturedRaw({chat_id:-100,text:'late raw'}),/Core Topic binding changed/);
    const core=getNativeCore()!;const pending=core.bindings.pendingDeletes()[0]!;
    assert.equal(core.bindings.registry.getById(coreBindingId(-100,2)),null);assert.equal(pending.sessionId,'owned');
    rejectRetirement(new Error('synthetic retirement unavailable'));await failure;
    started=new Promise<void>(resolve=>{infrastructureStarted=resolve;});
    const retry=deleteTelegramTopicSession(api,binding);const retried=assert.rejects(retry,/synthetic retirement unavailable/);await started;
    assert.equal(core.bindings.pendingDeletes()[0]?.bindingGeneration,pending.bindingGeneration);
    rejectRetirement(new Error('synthetic retirement unavailable'));await retried;assert.deepEqual(sent,['before']);
  }finally{topicNodeLifecycle.retire=original;await shutdownNativeCore();delete process.env.OPENCODE_TELEGRAM_HOME;}
});
