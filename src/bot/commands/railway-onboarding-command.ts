import {InlineKeyboard,type Context} from "grammy";
import {requestInfrastructureSetup} from "../../control-plane/application-transport.js";
import {deleteInputMessage} from "./panel-render.js";
import {keyboardManager} from "../keyboards/keyboard-manager.js";
import {pinnedMessageManager} from "../pinned/pinned-message-manager.js";
import {logger} from "../../utils/logger.js";
import {nodeBindings} from "../../control-plane/node-bindings.js";
import {setTopicNodeCreationEnabled,topicNodeLifecycle} from "../../control-plane/topic-node-lifecycle.js";
import {normalizeRailwayWorkerSettings,type RailwayWorkerSettings} from "../../infrastructure/railway-worker-settings.js";
import {WorkerProvisioningError} from "../../infrastructure/worker-provisioning-driver.js";
import {isRailwaySetupCompleted,setRailwaySetupCompleted} from "../../app/stores/settings-store.js";
import {canContinueRailwayBootstrapWithLimitedResources,isRailwayBootstrapResourceLimit,renderRailwayBootstrapLimit,renderRailwayBootstrapProgress,summarizeObservedRailwayBootstrap,type RailwayBootstrapProgress} from "../services/railway-bootstrap-progress.js";
import {t} from "../../i18n/index.js";

interface WorkspaceChoice {id:string;name:string}
interface SetupStatus {
  configured:boolean;
  tokenType?:"account"|"workspace";
  workspaceId?:string;
  workspaceName?:string;
  blockedReason?:"secret-invalid";
  projectCount?:number;
  workers?:Array<{nodeId:string;generation:number;projectId:string;serviceId?:string;volumeId?:string;verified?:boolean}>;
  deletedProjectIds?:string[];
  deletedWorkers?:Array<{nodeId:string;generation:number}>;
}
interface ValidationResult {valid:boolean;tokenType?:"account"|"workspace";subjectName?:string;workspaces?:WorkspaceChoice[];reason?:string}

const INITIAL_BOOTSTRAP_WORKERS=5;
const waitingForToken=new Set<number>();
const workspaceChoices=new Map<number,WorkspaceChoice[]>();
const bootstrapFlights=new Map<number,Promise<void>>();
const bootstrapMessageIds=new Map<number,number>();
const continueFlights=new Set<number>();

export function isRetryableRailwayBootstrapError(error:unknown):boolean{
 if(error instanceof WorkerProvisioningError)return error.category==="provisioning_pending"||error.category==="project_unavailable";
 const message=error instanceof Error?error.message:String(error);
 return /Node transport failed|Topic node readiness timed out|Infrastructure operation failed \((?:transport|rate_limit|provisioning_pending|project_unavailable),/iu.test(message);
}

function blockedVerificationDetail(error:unknown):string|undefined{
 const message=error instanceof Error?error.message:String(error);
 const match=/boundary_(replay|foreign-topic|stale-generation)_http_(\d{3})/u.exec(message);
 if(!match)return undefined;
 const checks:Record<string,string>={replay:"replay protection","foreign-topic":"foreign Topic isolation","stale-generation":"generation fencing"};
 return "Worker security verification failed: "+(checks[match[1]!]??"boundary check")+", HTTP "+match[2]+".";
}
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
 // Only explicit deletion evidence from the privileged inventory releases slots.
 for(const binding of bindings){
  if(binding.status!=="retired"&&binding.chatId===0&&binding.threadId===0&&(binding.projectId&&current.deletedProjectIds?.includes(binding.projectId)||current.deletedWorkers?.some(worker=>worker.nodeId===binding.nodeId&&worker.generation===binding.generation))){
   await nodeBindings.update(binding.nodeId,binding.generation,{status:"retired"});
   binding.status="retired";
  }
 }
 if(!Array.isArray(current.workers))throw new Error("Railway resource inventory unavailable");
 return summarizeObservedRailwayBootstrap(bindings,current.workers,current.projectCount??0,INITIAL_BOOTSTRAP_WORKERS);
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
  let retryDelayMs=1_500;
  let retry=0;
  while(true){
   let settled=false;
   let failure:unknown;
   const operation=topicNodeLifecycle.bootstrapPool(INITIAL_BOOTSTRAP_WORKERS).catch(error=>{failure=error;return [];}).finally(()=>{settled=true;});
   let lastSignature="";
   while(!settled){
    try{
     progress=await bootstrapProgress();
     const signature=JSON.stringify(progress);
     if(signature!==lastSignature){lastSignature=signature;await editBootstrapMessage(ctx,chatId,targetMessageId,progress);}
    }catch(error){progress={...progress,complete:false,verified:false};await editBootstrapMessage(ctx,chatId,targetMessageId,progress).catch(()=>{});logger.warn("[RailwayOnboarding] Could not refresh bootstrap progress",error);}
    await Promise.race([operation,new Promise(resolve=>setTimeout(resolve,1_500))]);
   }
   await operation;
   progress=await bootstrapProgress().catch(()=>({...progress,complete:false,verified:false}));
   if(!failure&&progress.complete){
    await editBootstrapMessage(ctx,chatId,targetMessageId,progress);
    logger.info(`[RailwayOnboarding] Initial fleet ready: chat=${chatId}, projects=${progress.projects}, workers=${progress.workers}, volumes=${progress.volumes}, healthy=${progress.healthy}`);
    return;
   }
   if(failure&&!isRetryableRailwayBootstrapError(failure)){
    if(isRailwayBootstrapResourceLimit(failure)){
     const keyboard=new InlineKeyboard().text(t("railway.setup.retry"),"railway:retry");
     if(canContinueRailwayBootstrapWithLimitedResources(progress,failure))keyboard.row().text(t("railway.setup.continue_limited"),"railway:continue-limited");
     await ctx.api.editMessageText(chatId,targetMessageId,renderRailwayBootstrapLimit(progress),{parse_mode:"HTML",reply_markup:keyboard}).catch(error=>logger.warn("[RailwayOnboarding] Could not render quota choices",error));
     logger.warn(`[RailwayOnboarding] Railway quota reached; verified=${progress.healthy}/${INITIAL_BOOTSTRAP_WORKERS}`);
     return;
    }
    logger.error("[RailwayOnboarding] Initial Worker bootstrap blocked by non-retryable error",failure);
    const retryKeyboard=new InlineKeyboard().text("Retry →","railway:retry");
    const detail=blockedVerificationDetail(failure);
    const blockedText=renderRailwayBootstrapProgress(progress)+"\n\n❌ Setup is blocked by a non-retryable Railway condition. Fix the Railway resource/configuration issue, then press Retry."+(detail?"\n\n🔎 "+detail:"");
    await ctx.api.editMessageText(chatId,targetMessageId,blockedText,{parse_mode:"HTML",reply_markup:retryKeyboard}).catch(()=>{});
    return;
   }
   retry++;
   logger.warn(`[RailwayOnboarding] Transient Worker bootstrap failure; retry=${retry} delayMs=${retryDelayMs}`,failure);
   await ctx.api.editMessageText(chatId,targetMessageId,`${renderRailwayBootstrapProgress(progress)}\n\n⏳ Recovering a transient Railway/Worker readiness failure automatically…`,{parse_mode:"HTML"}).catch(()=>{});
   await new Promise(resolve=>setTimeout(resolve,retryDelayMs));
   retryDelayMs=Math.min(Math.round(retryDelayMs*1.6),10_000);
  }
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
 if(data==="railway:retry"){
  try{
   const settings=normalizeRailwayWorkerSettings(await requestInfrastructureSetup("settings.get"));
   await ctx.answerCallbackQuery({text:"Retrying Railway setup…"}).catch(()=>{});
   await startRailwayBootstrap(ctx,settings,ctx.callbackQuery?.message?.message_id);
  }catch(error){logger.error("[RailwayOnboarding] Retry failed to start",error);await ctx.answerCallbackQuery({text:"Railway setup retry could not start."}).catch(()=>{});}
  return true;
 }
 if(data==="railway:continue"||data==="railway:continue-limited"){
  if(isRailwaySetupCompleted()||continueFlights.has(chatId)){await ctx.answerCallbackQuery().catch(()=>{});return true;}
  continueFlights.add(chatId);
  try{
   const limited=data==="railway:continue-limited";
   let quota:unknown;
   if(limited){
    await ctx.answerCallbackQuery({text:t("railway.setup.limited_checking")}).catch(()=>{});
    // Recheck live health, global state and root security proofs. This also
    // makes a pre-restart button safe without trusting an in-memory receipt.
    await topicNodeLifecycle.bootstrapPool(INITIAL_BOOTSTRAP_WORKERS).catch(error=>{quota=error;});
   }
   const progress=await bootstrapProgress();
   const verifiedLimited=limited&&canContinueRailwayBootstrapWithLimitedResources(progress,quota);
   if((quota&&!verifiedLimited)||(!progress.complete&&!verifiedLimited)){
    if(limited)await ctx.reply(t("railway.setup.limited_unavailable"));
    else await ctx.answerCallbackQuery({text:"Railway is still preparing Workers."}).catch(()=>{});
    return true;
   }
   if(!limited)await ctx.answerCallbackQuery({text:"Railway ready ✅"}).catch(()=>{});
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
  finally{continueFlights.delete(chatId);}
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
