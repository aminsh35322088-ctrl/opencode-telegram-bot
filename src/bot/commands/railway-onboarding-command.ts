import {InlineKeyboard,type Context} from "grammy";
import {requestInfrastructureSetup} from "../../control-plane/application-transport.js";
import {deleteInputMessage} from "./panel-render.js";
import {keyboardManager} from "../keyboards/keyboard-manager.js";
import {pinnedMessageManager} from "../pinned/pinned-message-manager.js";
import {logger} from "../../utils/logger.js";
import {nodeBindings} from "../../control-plane/node-bindings.js";
import {setTopicNodeCreationEnabled,topicNodeLifecycle} from "../../control-plane/topic-node-lifecycle.js";
import {normalizeRailwayWorkerSettings,type RailwayWorkerSettings} from "../../infrastructure/railway-worker-settings.js";
import {isRailwaySetupCompleted,setRailwaySetupCompleted} from "../../app/stores/settings-store.js";
import {renderRailwayBootstrapProgress,summarizeRailwayBootstrap,type RailwayBootstrapProgress} from "../services/railway-bootstrap-progress.js";

interface WorkspaceChoice {id:string;name:string}
interface SetupStatus {
  configured:boolean;
  tokenType?:"account"|"workspace";
  workspaceId?:string;
  workspaceName?:string;
  blockedReason?:"secret-invalid";
  projectCount?:number;
}
interface ValidationResult {valid:boolean;tokenType?:"account"|"workspace";subjectName?:string;workspaces?:WorkspaceChoice[];reason?:string}

const INITIAL_BOOTSTRAP_WORKERS=5;
const waitingForToken=new Set<number>();
const workspaceChoices=new Map<number,WorkspaceChoice[]>();
const bootstrapFlights=new Map<number,Promise<void>>();
const bootstrapMessageIds=new Map<number,number>();

function setupAvailable():boolean{return process.env.CONTROL_APPLICATION_IPC==="1";}
function rootThread(ctx:Context):boolean{
 const threadId=ctx.message?.message_thread_id??(ctx.callbackQuery?.message&&"message_thread_id" in ctx.callbackQuery.message?ctx.callbackQuery.message.message_thread_id:undefined);
 return typeof threadId!=="number"||threadId<=1;
}
function status(value:unknown):SetupStatus{
 if(!value||typeof value!=="object"||typeof (value as {configured?:unknown}).configured!=="boolean")throw new Error("Invalid Railway setup response");
 const candidate=value as SetupStatus;
 if(candidate.blockedReason!==undefined&&candidate.blockedReason!=="secret-invalid")throw new Error("Invalid Railway setup response");
 if(candidate.projectCount!==undefined&&(!Number.isSafeInteger(candidate.projectCount)||candidate.projectCount<0||candidate.projectCount>1000))throw new Error("Invalid Railway setup response");
 if(candidate.configured&&(candidate.tokenType!=="account"&&candidate.tokenType!=="workspace"||typeof candidate.workspaceId!=="string"||!candidate.workspaceId))throw new Error("Invalid Railway setup response");
 return candidate;
}
function validation(value:unknown):ValidationResult{
 if(!value||typeof value!=="object"||typeof (value as {valid?:unknown}).valid!=="boolean")throw new Error("Invalid Railway validation response");
 const candidate=value as ValidationResult;
 if(!candidate.valid)return {valid:false,reason:typeof candidate.reason==="string"?candidate.reason:"invalid"};
 if(candidate.tokenType!=="account"&&candidate.tokenType!=="workspace")throw new Error("Invalid Railway validation response");
 const workspaces=(Array.isArray(candidate.workspaces)?candidate.workspaces:[]).filter((item):item is WorkspaceChoice=>Boolean(item)&&typeof item.id==="string"&&item.id.length>0&&item.id.length<=256&&typeof item.name==="string"&&item.name.trim().length>0&&item.name.length<=256).slice(0,100);
 return {valid:true,tokenType:candidate.tokenType,subjectName:typeof candidate.subjectName==="string"?candidate.subjectName:undefined,workspaces};
}
async function sendSetupPrompt(ctx:Context):Promise<void>{
 const keyboard=new InlineKeyboard().text("Cancel","railway:cancel");
 await ctx.reply("🚂 Railway setup\n\nSend a Railway Account or Workspace token. The bot needs this access to create and manage isolated Topic Workers.\n\nA Project token is not enough for dynamic Worker projects. Your token message will be deleted immediately after it is received.",{reply_markup:keyboard});
}
async function normalizeInitialSettings(settings:RailwayWorkerSettings):Promise<RailwayWorkerSettings>{
 if(settings.warmCapacity===INITIAL_BOOTSTRAP_WORKERS&&settings.workerCreationEnabled)return settings;
 return normalizeRailwayWorkerSettings(await requestInfrastructureSetup("settings.update",{patch:{workerCreationEnabled:true,warmCapacity:INITIAL_BOOTSTRAP_WORKERS}}));
}
async function bootstrapProgress():Promise<RailwayBootstrapProgress>{
 const current=status(await requestInfrastructureSetup("status"));
 if(!current.configured)throw new Error("Railway setup is not configured");
 const bindings=await nodeBindings.list();
 const bindingProjects=new Set(bindings.filter(binding=>binding.status!=="retired"&&binding.slot!==undefined&&binding.slot<=INITIAL_BOOTSTRAP_WORKERS&&binding.projectId).map(binding=>binding.projectId!)).size;
 return summarizeRailwayBootstrap(bindings,Math.max(current.projectCount??0,bindingProjects),INITIAL_BOOTSTRAP_WORKERS);
}
function continueKeyboard(progress:RailwayBootstrapProgress):InlineKeyboard|undefined{
 return progress.complete?new InlineKeyboard().text("Continue →","railway:continue"):undefined;
}
async function editBootstrapMessage(ctx:Context,chatId:number,messageId:number,progress:RailwayBootstrapProgress):Promise<void>{
 const keyboard=continueKeyboard(progress);
 await ctx.api.editMessageText(chatId,messageId,renderRailwayBootstrapProgress(progress),{
  parse_mode:"HTML",
  ...(keyboard?{reply_markup:keyboard}:{}),
 }).catch(error=>{
  if(!/message is not modified/i.test(error instanceof Error?error.message:String(error)))throw error;
 });
}
async function startRailwayBootstrap(ctx:Context,settingsInput:RailwayWorkerSettings,reuseMessageId?:number):Promise<void>{
 const chatId=ctx.chat?.id??ctx.callbackQuery?.message?.chat.id;
 if(typeof chatId!=="number")return;
 if(isRailwaySetupCompleted())return;
 const settings=await normalizeInitialSettings(settingsInput);
 setTopicNodeCreationEnabled(settings.workerCreationEnabled);
 let progress=await bootstrapProgress();
 let messageId=reuseMessageId??bootstrapMessageIds.get(chatId);
 if(messageId){await editBootstrapMessage(ctx,chatId,messageId,progress);}
 else{
  const sent=await ctx.reply(renderRailwayBootstrapProgress(progress),{parse_mode:"HTML",...(progress.complete?{reply_markup:continueKeyboard(progress)}:{})});
  messageId=sent.message_id;
 }
 bootstrapMessageIds.set(chatId,messageId);
 if(progress.complete||bootstrapFlights.has(chatId))return;
 const targetMessageId=messageId;
 const flight=(async()=>{
  let settled=false;
  let failure:unknown;
  const operation=topicNodeLifecycle.bootstrapPool(INITIAL_BOOTSTRAP_WORKERS).catch(error=>{failure=error;return [];}).finally(()=>{settled=true;});
  let lastSignature="";
  while(!settled){
   try{
    progress=await bootstrapProgress();
    const signature=JSON.stringify(progress);
    if(signature!==lastSignature){lastSignature=signature;await editBootstrapMessage(ctx,chatId,targetMessageId,progress);}
   }catch(error){logger.warn("[RailwayOnboarding] Could not refresh bootstrap progress",error);}
   await Promise.race([operation,new Promise(resolve=>setTimeout(resolve,1500))]);
  }
  await operation;
  if(failure){
   logger.error("[RailwayOnboarding] Initial Worker bootstrap failed",failure);
   const latest=await bootstrapProgress().catch(()=>progress);
   await ctx.api.editMessageText(chatId,targetMessageId,`${renderRailwayBootstrapProgress(latest)}\n\n❌ Setup paused. Run /start to retry the failed Railway step.`,{parse_mode:"HTML"}).catch(()=>{});
   return;
  }
  progress=await bootstrapProgress();
  await editBootstrapMessage(ctx,chatId,targetMessageId,progress);
  logger.info(`[RailwayOnboarding] Initial fleet ready: chat=${chatId}, projects=${progress.projects}, workers=${progress.workers}, volumes=${progress.volumes}, healthy=${progress.healthy}`);
 })().finally(()=>bootstrapFlights.delete(chatId));
 bootstrapFlights.set(chatId,flight);void flight;
}

export async function ensureRailwayInfrastructureConfigured(ctx:Context):Promise<boolean>{
 if(!setupAvailable())return true;
 const chatId=ctx.chat?.id;
 if(typeof chatId!=="number"||!rootThread(ctx))return true;
 try{
  const current=status(await requestInfrastructureSetup("status"));
  if(current.blockedReason==="secret-invalid"){
   waitingForToken.delete(chatId);workspaceChoices.delete(chatId);
   await ctx.reply("❌ <b>Railway Secret is invalid</b>\n\nThe RAILWAY_API_TOKEN configured in Railway Secrets could not be authenticated or cannot access this Control Plane workspace. Fix or remove that Secret and redeploy. Telegram onboarding is disabled while the Secret is present.",{parse_mode:"HTML"});
   return false;
  }
  if(current.configured){
   waitingForToken.delete(chatId);workspaceChoices.delete(chatId);
   const settings=normalizeRailwayWorkerSettings(await requestInfrastructureSetup("settings.get"));
   setTopicNodeCreationEnabled(settings.workerCreationEnabled);
   if(isRailwaySetupCompleted())return true;
   await startRailwayBootstrap(ctx,settings);
   return false;
  }
  waitingForToken.add(chatId);workspaceChoices.delete(chatId);await sendSetupPrompt(ctx);return false;
 }catch(error){
  logger.error("[RailwayOnboarding] Failed to read Control Plane setup status",error);
  await ctx.reply("❌ Railway Control Plane setup is unavailable right now. Run /start again after the Control Plane is healthy.");
  return false;
 }
}

export async function handleRailwayOnboardingMessage(ctx:Context):Promise<boolean>{
 if(!setupAvailable()||!ctx.chat||!ctx.message?.text||!rootThread(ctx)||!waitingForToken.has(ctx.chat.id)||ctx.message.text.startsWith("/"))return false;
 const chatId=ctx.chat.id;
 const token=ctx.message.text.trim();
 await deleteInputMessage(ctx);
 if(!token){await sendSetupPrompt(ctx);return true;}
 waitingForToken.delete(chatId);
 try{
  const result=validation(await requestInfrastructureSetup("credential.begin",{token}));
  if(!result.valid){
   waitingForToken.add(chatId);
   const reason=result.reason==="unauthorized"?"The token was not authorized for Railway infrastructure access.":result.reason==="network"?"Railway could not be reached while validating the token.":result.reason==="scope"?"The token cannot access the Control Plane workspace.":"The Railway token is invalid.";
   await ctx.reply(`❌ ${reason}\n\nSend another Railway Account or Workspace token.`);
   return true;
  }
  const choices=result.workspaces??[];
  if(choices.length===0){waitingForToken.add(chatId);await ctx.reply("❌ No accessible Railway workspace was returned for this token. Send a different Account or Workspace token.");return true;}
  workspaceChoices.set(chatId,choices);
  const keyboard=new InlineKeyboard();
  choices.forEach((workspace,index)=>{keyboard.text(workspace.name.slice(0,48),`railway:workspace:${index}`).row();});
  keyboard.text("Cancel","railway:cancel");
  await ctx.reply(`✅ Railway token verified.\n\nChoose the workspace where this bot should create and manage the Topic Worker fleet:${result.subjectName?`\n\nAccount: ${result.subjectName}`:""}`,{reply_markup:keyboard});
  return true;
 }catch(error){
  waitingForToken.add(chatId);workspaceChoices.delete(chatId);logger.error("[RailwayOnboarding] Token validation failed",error);
  await ctx.reply("❌ Railway token validation failed. Send the token again or run /start to restart setup.");return true;
 }
}

export async function handleRailwayOnboardingCallback(ctx:Context):Promise<boolean>{
 const data=ctx.callbackQuery?.data??"";
 if(!data.startsWith("railway:"))return false;
 const chatId=ctx.chat?.id??ctx.callbackQuery?.message?.chat.id;
 if(typeof chatId!=="number"||!rootThread(ctx)){await ctx.answerCallbackQuery({text:"Use General for Railway setup."}).catch(()=>{});return true;}
 if(data==="railway:continue"){
  try{
   const progress=await bootstrapProgress();
   if(!progress.complete){await ctx.answerCallbackQuery({text:"Railway is still preparing Workers."}).catch(()=>{});return true;}
   await ctx.answerCallbackQuery({text:"Railway ready ✅"}).catch(()=>{});
   if(!pinnedMessageManager.isInitialized())pinnedMessageManager.initialize(ctx.api,chatId);
   keyboardManager.initialize(ctx.api,chatId);
   const opened=await keyboardManager.replaceMainInlineKeyboard(chatId);
   if(!opened)throw new Error("Main panel replacement failed");
   await setRailwaySetupCompleted(true);
   const messageId=ctx.callbackQuery?.message?.message_id;
   if(messageId)await ctx.api.deleteMessage(chatId,messageId).catch(()=>{});
   bootstrapMessageIds.delete(chatId);
   return true;
  }catch(error){logger.error("[RailwayOnboarding] Continue failed",error);await ctx.answerCallbackQuery({text:"Railway setup is not ready yet."}).catch(()=>{});return true;}
 }
 if(data==="railway:cancel"){
  waitingForToken.delete(chatId);workspaceChoices.delete(chatId);await ctx.answerCallbackQuery().catch(()=>{});
  await ctx.editMessageText("Railway setup cancelled. Run /start when you are ready to connect Railway.").catch(()=>{});return true;
 }
 const match=/^railway:workspace:(\d{1,3})$/u.exec(data);
 if(!match){await ctx.answerCallbackQuery({text:"Unknown Railway setup action."}).catch(()=>{});return true;}
 const choices=workspaceChoices.get(chatId);const choice=choices?.[Number(match[1])];
 if(!choice){await ctx.answerCallbackQuery({text:"This Railway setup session expired. Run /start again."}).catch(()=>{});return true;}
 try{
  const selected=status(await requestInfrastructureSetup("workspace.select",{workspaceId:choice.id}));
  if(!selected.configured)throw new Error("Railway workspace was not activated");
  waitingForToken.delete(chatId);workspaceChoices.delete(chatId);
  const settings=normalizeRailwayWorkerSettings(await requestInfrastructureSetup("settings.get"));setTopicNodeCreationEnabled(settings.workerCreationEnabled);
  await ctx.answerCallbackQuery({text:"Railway connected ✅"}).catch(()=>{});
  const messageId=ctx.callbackQuery?.message?.message_id;
  await startRailwayBootstrap(ctx,settings,messageId);
  logger.info(`[RailwayOnboarding] Workspace activated: chat=${chatId}, workspace=${selected.workspaceId}`);
  return true;
 }catch(error){
  workspaceChoices.delete(chatId);waitingForToken.add(chatId);
  logger.error("[RailwayOnboarding] Workspace activation failed",error);
  await ctx.answerCallbackQuery({text:"Railway workspace activation failed."}).catch(()=>{});
  await ctx.reply("❌ Could not activate this Railway workspace. Send the Railway token again to retry.");return true;
 }
}
