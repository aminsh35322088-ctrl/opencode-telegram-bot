import {InlineKeyboard,type Context} from "grammy";
import {requestInfrastructureSetup} from "../../control-plane/application-transport.js";
import {deleteInputMessage,escapeHtml} from "./panel-render.js";
import {keyboardManager} from "../keyboards/keyboard-manager.js";
import {pinnedMessageManager} from "../pinned/pinned-message-manager.js";
import {logger} from "../../utils/logger.js";
import {setTopicNodeCreationEnabled} from "../../control-plane/topic-node-lifecycle.js";
import {normalizeRailwayWorkerSettings} from "../../infrastructure/railway-worker-settings.js";

interface WorkspaceChoice {id:string;name:string}
interface SetupStatus {configured:boolean;tokenType?:"account"|"workspace";workspaceId?:string;workspaceName?:string}
interface ValidationResult {valid:boolean;tokenType?:"account"|"workspace";subjectName?:string;workspaces?:WorkspaceChoice[];reason?:string}

const waitingForToken=new Set<number>();
const workspaceChoices=new Map<number,WorkspaceChoice[]>();

function setupAvailable():boolean{return process.env.CONTROL_APPLICATION_IPC==="1";}
function rootThread(ctx:Context):boolean{
 const threadId=ctx.message?.message_thread_id??(ctx.callbackQuery?.message&&"message_thread_id" in ctx.callbackQuery.message?ctx.callbackQuery.message.message_thread_id:undefined);
 return typeof threadId!=="number"||threadId<=1;
}
function status(value:unknown):SetupStatus{
 if(!value||typeof value!=="object"||typeof (value as {configured?:unknown}).configured!=="boolean")throw new Error("Invalid Railway setup response");
 const candidate=value as SetupStatus;
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

export async function ensureRailwayInfrastructureConfigured(ctx:Context):Promise<boolean>{
 if(!setupAvailable())return true;
 const chatId=ctx.chat?.id;
 if(typeof chatId!=="number"||!rootThread(ctx))return true;
 try{
  const current=status(await requestInfrastructureSetup("status"));
  if(current.configured){waitingForToken.delete(chatId);workspaceChoices.delete(chatId);const settings=normalizeRailwayWorkerSettings(await requestInfrastructureSetup("settings.get"));setTopicNodeCreationEnabled(settings.workerCreationEnabled);return true;}
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
  waitingForToken.delete(chatId);workspaceChoices.delete(chatId);const settings=normalizeRailwayWorkerSettings(await requestInfrastructureSetup("settings.get"));setTopicNodeCreationEnabled(settings.workerCreationEnabled);
  await ctx.answerCallbackQuery({text:"Railway connected ✅"}).catch(()=>{});
  await ctx.editMessageText(`✅ <b>Railway connected</b>\n\nWorkspace: <b>${escapeHtml(selected.workspaceName??choice.name)}</b>\n\nNew Chat can now provision isolated Topic Workers.`,{parse_mode:"HTML"}).catch(()=>{});
  if(!pinnedMessageManager.isInitialized())pinnedMessageManager.initialize(ctx.api,chatId);
  keyboardManager.initialize(ctx.api,chatId);
  await keyboardManager.replaceMainInlineKeyboard(chatId);
  logger.info(`[RailwayOnboarding] Workspace activated: chat=${chatId}, workspace=${selected.workspaceId}`);
  return true;
 }catch(error){
  workspaceChoices.delete(chatId);waitingForToken.add(chatId);
  logger.error("[RailwayOnboarding] Workspace activation failed",error);
  await ctx.answerCallbackQuery({text:"Railway workspace activation failed."}).catch(()=>{});
  await ctx.reply("❌ Could not activate this Railway workspace. Send the Railway token again to retry.");return true;
 }
}
