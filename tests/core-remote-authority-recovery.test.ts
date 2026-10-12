import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { Api } from "grammy";
import { RailwayResourceGovernor } from "@opencode-telegram/native-runtime";
import { initializeNativeCore, shutdownNativeCore, getNativeCore, restoreRemoteCoreRun, finishCoreRunForSession, coreBindingId } from "../src/core/native-core-service.js";
import { runInTopicRuntimeContext } from "../src/app/services/topic-runtime-context.js";
import { createCoreSessionApi } from "../src/bot/services/core-session-api.js";
import { saveTelegramTopicBinding } from "../src/app/services/telegram-topic-store.js";
import { deleteTelegramTopicSession } from "../src/app/services/telegram-topic-delete-service.js";
import { nodeBindings, type NodeBinding } from "../src/control-plane/node-bindings.js";
import { topicNodeLifecycle } from "../src/control-plane/topic-node-lifecycle.js";
import { opencodeClient } from "../src/opencode/client.js";
// Deterministic synthetic fixtures only; never inherit production Telegram credentials.
process.env.TELEGRAM_BOT_TOKEN="12345:synthetic-authority-test";
process.env.TELEGRAM_USER_ID="12345";
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
test('distributed Topic output uses the exact ready remote Worker when local Core is intentionally absent',async()=>{
  const home=await mkdtemp(path.join(tmpdir(),'remote-topic-output-'));
  const previousHome=process.env.OPENCODE_TELEGRAM_HOME;process.env.OPENCODE_TELEGRAM_HOME=home;
  const sent:Array<{chatId:number;threadId?:number;text:string}>=[];
  const api={sendMessage:async(chatId:number,text:string,options?:{message_thread_id?:number})=>{sent.push({chatId,threadId:options?.message_thread_id,text});},raw:{sendMessage:async(input:{chat_id:number;text:string;message_thread_id?:number})=>{sent.push({chatId:input.chat_id,threadId:input.message_thread_id,text:input.text});}}} as unknown as Api;
  try {
    await shutdownNativeCore();
    await saveTelegramTopicBinding({...topic,createdAt:'now',updatedAt:'now'});
    assert.equal(getNativeCore(),null);
    await createCoreSessionApi(api,topic.sessionId).sendMessage(topic.chatId,'ready');
    assert.deepEqual(sent,[{chatId:topic.chatId,threadId:topic.threadId,text:'ready'}]);
    const scoped=createCoreSessionApi(api,topic.sessionId);
    await scoped.raw.sendMessage({chat_id:topic.chatId,text:'raw'} as never);
    assert.deepEqual(sent.at(-1),{chatId:topic.chatId,threadId:topic.threadId,text:'raw'});
    await assert.rejects(scoped.sendMessage(-200,'foreign'),/chat differs from remote Topic binding/);
    const originalFind=nodeBindings.find;
    try {
      nodeBindings.find=async()=>({...node,status:'failed'});
      await assert.rejects(scoped.sendMessage(topic.chatId,'stale'),/does not own ready session/);
    } finally {nodeBindings.find=originalFind;}
    assert.equal(sent.length,2);
  } finally {
    await shutdownNativeCore();
    if(previousHome===undefined)delete process.env.OPENCODE_TELEGRAM_HOME;else process.env.OPENCODE_TELEGRAM_HOME=previousHome;
    await rm(home,{recursive:true,force:true});
  }
});
test('remote Topic cleanup never deletes a recycled Worker session through the local OpenCode client',async()=>{
  const home=await mkdtemp(path.join(tmpdir(),'remote-topic-delete-'));
  const previousHome=process.env.OPENCODE_TELEGRAM_HOME;const previousIpc=process.env.CONTROL_APPLICATION_IPC;process.env.OPENCODE_TELEGRAM_HOME=home;process.env.CONTROL_APPLICATION_IPC='1';
  const workspace=path.join(home,'opencode','topic-workspaces',String(topic.chatId),'workspace');
  const fs=await import('node:fs/promises');await fs.mkdir(workspace,{recursive:true});
  const originalFind=nodeBindings.find;const originalList=nodeBindings.list;const originalRetire=topicNodeLifecycle.retire;
  const originalDelete=opencodeClient.session.delete;let current:NodeBinding={...node,chatId:0,threadId:0,status:'available',sessionId:undefined,generation:2};let localDeletes=0;let forumDeletes=0;
  nodeBindings.find=async()=>undefined;
  nodeBindings.list=async()=>[current];
  topicNodeLifecycle.retire=async()=>{throw new Error('A recycled Worker must not be retired twice');};
  opencodeClient.session.delete=async()=>{localDeletes++;return {data:true} as never;};
  const api={sendMessage:async()=>({message_id:1}),pinChatMessage:async()=>{},deleteForumTopic:async()=>{forumDeletes++;}} as unknown as Api;
  try {
    await saveTelegramTopicBinding({...topic,directory:workspace,createdAt:'now',updatedAt:'now'});
    await deleteTelegramTopicSession(api,{...topic,directory:workspace,createdAt:'now',updatedAt:'now'});
    assert.equal(localDeletes,0);
    assert.equal(forumDeletes,1);
    assert.equal(await fs.stat(workspace).then(()=>true,()=>false),false);
  } finally {
    nodeBindings.find=originalFind;nodeBindings.list=originalList;topicNodeLifecycle.retire=originalRetire;
    opencodeClient.session.delete=originalDelete;
    if(previousIpc===undefined)delete process.env.CONTROL_APPLICATION_IPC;else process.env.CONTROL_APPLICATION_IPC=previousIpc;
    if(previousHome===undefined)delete process.env.OPENCODE_TELEGRAM_HOME;else process.env.OPENCODE_TELEGRAM_HOME=previousHome;
    await rm(home,{recursive:true,force:true});
  }
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
