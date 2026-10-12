import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import type {Context} from "grammy";

test("limited Continue rechecks quota and verified Workers before persisting Main panel admission",async t=>{
 process.env.OPENCODE_TELEGRAM_HOME=await mkdtemp(path.join(tmpdir(),"railway-limited-"));
 const originalSend=process.send;
 const listeners=process.listeners("message");
 process.send=((request:{requestId:string;operation:string})=>{
  assert.ok(["status","settings.get"].includes(request.operation));
  const result=request.operation==="settings.get"?{workerCreationEnabled:true,warmCapacity:5,workersPerProject:5}:{configured:true,tokenType:"workspace",workspaceId:"w",projectCount:1};
  queueMicrotask(()=>process.emit("message",{channel:"infrastructure-configure-response",requestId:request.requestId,ok:true,result},undefined));
  return true;
 }) as typeof process.send;
 const {installInfrastructureTransport}=await import("../src/control-plane/application-transport.js");
 installInfrastructureTransport();
 const {handleRailwayOnboardingCallback}=await import("../src/bot/commands/railway-onboarding-command.js");
 const {nodeBindings}=await import("../src/control-plane/node-bindings.js");
 const {topicNodeLifecycle}=await import("../src/control-plane/topic-node-lifecycle.js");
 const {keyboardManager}=await import("../src/bot/keyboards/keyboard-manager.js");
 const {pinnedMessageManager}=await import("../src/bot/pinned/pinned-message-manager.js");
 const {isRailwaySetupCompleted,setRailwaySetupCompleted}=await import("../src/app/stores/settings-store.js");
 const quota=new Error("Infrastructure operation failed (resource_limit, HTTP 200)");
 const cases=[
  {name:"four verified Workers plus quota opens Main",count:4,error:quota,limited:true,panel:true,expected:true},
  {name:"quota with no verified Worker stays blocked",count:0,error:quota,limited:true,panel:true,expected:false},
  {name:"security failure cannot use limited Continue",count:4,error:new Error("Infrastructure operation failed (verification, HTTP 200)"),limited:true,panel:true,expected:false},
  {name:"transport failure cannot use limited Continue",count:4,error:new Error("Node transport failed"),limited:true,panel:true,expected:false},
  {name:"policy capacity exhaustion cannot impersonate a free plan limit",count:4,error:new Error("NO WORKER AVAILABLE / CAPACITY EXHAUSTED"),limited:true,panel:true,expected:false},
  {name:"failure to open Main does not persist completion",count:4,error:quota,limited:true,panel:false,expected:false},
  {name:"normal Continue still requires all five Workers",count:4,error:undefined,limited:false,panel:true,expected:false},
  {name:"full recovery also admits a previously limited button",count:5,error:undefined,limited:true,panel:true,expected:true},
 ];
 try{
  for(const scenario of cases)await t.test(scenario.name,async sub=>{
   await setRailwaySetupCompleted(false);
   let probes=0,opened=0,deleted=0;
   sub.mock.method(nodeBindings,"list",async()=>Array.from({length:scenario.count},(_,index)=>({nodeId:`n${index}`,slot:index+1,generation:1,chatId:0,threadId:0,projectId:"p",serviceId:`s${index}`,volumeId:`v${index}`,status:"available"})));
   sub.mock.method(topicNodeLifecycle,"bootstrapPool",async target=>{assert.equal(target,5);probes++;if(scenario.error)throw scenario.error;return [];});
   sub.mock.method(pinnedMessageManager,"isInitialized",()=>true);
   sub.mock.method(keyboardManager,"initialize",()=>{});
   sub.mock.method(keyboardManager,"replaceMainInlineKeyboard",async()=>{opened++;return scenario.panel;});
   const ctx={chat:{id:-100},callbackQuery:{data:scenario.limited?"railway:continue-limited":"railway:continue",message:{message_id:7,chat:{id:-100}}},answerCallbackQuery:async()=>{},reply:async()=>{},api:{deleteMessage:async()=>{deleted++;}}} as unknown as Context;
   assert.deepEqual(await Promise.all([handleRailwayOnboardingCallback(ctx),handleRailwayOnboardingCallback(ctx),handleRailwayOnboardingCallback(ctx)]),[true,true,true]);
   assert.equal(isRailwaySetupCompleted(),scenario.expected);
   assert.equal(probes,scenario.limited?1:0);
   assert.equal(deleted,scenario.expected?1:0);
   if(scenario.expected){
    assert.equal(opened,1);
    await handleRailwayOnboardingCallback(ctx);
    assert.equal(opened,1,"duplicate Continue must be idempotent");
    assert.equal(probes,1,"duplicate Continue must not reprovision");
   }
  });
  await t.test("Retry renders truthful Free plan limit choices with real newlines",async sub=>{
   await setRailwaySetupCompleted(false);
   sub.mock.method(nodeBindings,"list",async()=>Array.from({length:4},(_,index)=>({nodeId:`n${index}`,slot:index+1,projectId:"p",serviceId:`s${index}`,volumeId:`v${index}`,status:"available"})));
   sub.mock.method(topicNodeLifecycle,"bootstrapPool",async()=>{throw quota;});
   let finish:()=>void=()=>{};
   const rendered=new Promise<void>(resolve=>{finish=resolve;});
   const ctx={chat:{id:-100},callbackQuery:{data:"railway:retry",message:{message_id:7,chat:{id:-100}}},answerCallbackQuery:async()=>{},api:{editMessageText:async(_chat:number,_id:number,text:string,options:{reply_markup?:{inline_keyboard:Array<Array<{text:string;callback_data:string}>>}})=>{
    if(!text.includes("Free plan limit"))return;
    assert.match(text,/4\/5/);assert.doesNotMatch(text,/\\n/);
    const buttons=options.reply_markup?.inline_keyboard.flat()??[];
    assert.ok(buttons.some(button=>button.callback_data==="railway:continue-limited"&&button.text.includes("Continue with limited resources")));
    assert.ok(buttons.some(button=>button.callback_data==="railway:retry"));
    finish();
   }}} as unknown as Context;
   await handleRailwayOnboardingCallback(ctx);
   await rendered;
   assert.equal(isRailwaySetupCompleted(),false,"offering limited capacity still requires explicit Continue");
  });
 }finally{
  process.send=originalSend;
  for(const listener of process.listeners("message"))if(!listeners.includes(listener))process.removeListener("message",listener);
 }
});
