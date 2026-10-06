import {randomUUID} from "node:crypto";
import type {NodeBinding} from "./node-bindings.js";
import type {ProvisionedNode} from "../infrastructure/node-provisioner.js";
import type {NodeEnvelope} from "./node-protocol.js";
import {installSecureNodeTransport} from "./topic-node-client.js";

let callInfrastructure:((channel:string,payload:Record<string,unknown>,timeout:number)=>Promise<unknown>)|undefined;
export async function requestInfrastructure(operation:"provision"|"retire"|"reconcile",nodeId:string,generation:number):Promise<ProvisionedNode>{
 if(!callInfrastructure)throw new Error("Infrastructure channel unavailable");
 return await callInfrastructure("infrastructure-request",{operation,nodeId,generation},300_000) as ProvisionedNode;
}
export async function requestNodeLifecycle(binding:Readonly<NodeBinding>,operation:"health"|"status"|"sync-global"|"session.create"|"session.get",payload:unknown={}):Promise<{ok:boolean;result:unknown}>{
 if(!callInfrastructure)throw new Error("Infrastructure channel unavailable");
 if(!["health","status","sync-global","session.create","session.get"].includes(operation))throw new Error("Lifecycle operation denied");
 const envelope:NodeEnvelope={version:1,nodeId:binding.nodeId,generation:binding.generation,chatId:binding.chatId,threadId:binding.threadId,sessionId:binding.sessionId,operation,payload,timestamp:Date.now(),nonce:randomUUID()};
 return await callInfrastructure("worker-request",{envelope},50_000) as {ok:boolean;result:unknown};
}
export function installInfrastructureTransport():void{
 if(!process.send)return;
 const waits=new Map<string,{resolve:(value:unknown)=>void;reject:(error:Error)=>void}>();
 const streams=new Map<string,{events:NodeEnvelope[];ended:boolean;error?:Error;wake?:()=>void;onReady?:()=>void}>();
 process.on("message",(message:unknown)=>{
  if(!message||typeof message!=="object")return;
  const response=message as {channel?:string;requestId?:string;ok?:boolean;result?:unknown;event?:NodeEnvelope;errorCode?:string;httpStatus?:number};
  if(!response.requestId)return;
  if(response.channel==="worker-response" || response.channel==="infrastructure-response"){
   const wait=waits.get(response.requestId);if(!wait)return;waits.delete(response.requestId);
   if(response.ok)wait.resolve(response.result);else wait.reject(new Error(response.channel==="infrastructure-response" && ["schema","resource_limit","rate_limit","transport","rejected","verification"].includes(response.errorCode??"")?`Infrastructure operation failed (${response.errorCode}, HTTP ${Number.isSafeInteger(response.httpStatus)?response.httpStatus:0})`:"Node transport failed"));
  }else if(response.channel==="worker-stream-ready"){
   streams.get(response.requestId)?.onReady?.();
  }else if(response.channel==="worker-event" || response.channel==="worker-stream-end"){
   const stream=streams.get(response.requestId);if(!stream)return;
   if(response.channel==="worker-stream-end"){stream.ended=true;if(!response.ok)stream.error=new Error("Node stream failed");}
   else if(response.event){
    if(stream.events.length>=128){stream.ended=true;stream.error=new Error("Node event consumer exceeded capacity");process.send?.({channel:"worker-cancel",requestId:response.requestId});}
    else stream.events.push(response.event);
   }
   stream.wake?.();stream.wake=undefined;
  }
 });
 callInfrastructure=async(channel,payload,timeout)=>{
  if(waits.size>=8)throw new Error("Infrastructure request capacity exceeded");
  const requestId=randomUUID();let timer:NodeJS.Timeout|undefined;
  try{return await new Promise((resolve,reject)=>{
   waits.set(requestId,{resolve,reject});timer=setTimeout(()=>{waits.delete(requestId);reject(new Error("Infrastructure request timed out"));},timeout);
   process.send?.({channel,requestId,...payload},error=>{if(error){waits.delete(requestId);reject(new Error("Infrastructure channel unavailable"));}});
  });}finally{if(timer)clearTimeout(timer);waits.delete(requestId);}
 };
 installSecureNodeTransport({
  request:async(_binding,envelope,options)=>{
   if(waits.size>=8)throw new Error("Node request capacity exceeded");
   const requestId=randomUUID();let timer:NodeJS.Timeout|undefined;
   const abort=()=>{const wait=waits.get(requestId);waits.delete(requestId);process.send?.({channel:"worker-cancel",requestId});wait?.reject(new Error("Node request cancelled"));};
   try{return await new Promise((resolve,reject)=>{
    if(options?.signal?.aborted){reject(new Error("Node request cancelled"));return;}
    waits.set(requestId,{resolve,reject});timer=setTimeout(abort,50_000);options?.signal?.addEventListener("abort",abort,{once:true});
    process.send?.({channel:"worker-request",requestId,envelope},error=>{if(error){waits.delete(requestId);reject(new Error("Infrastructure channel unavailable"));}});
   });}finally{if(timer)clearTimeout(timer);options?.signal?.removeEventListener("abort",abort);waits.delete(requestId);}
  },
  stream:async function*(_binding,envelope,options){
   if(streams.size>=4)throw new Error("Node stream capacity exceeded");
   const requestId=randomUUID();const state:{events:NodeEnvelope[];ended:boolean;error?:Error;wake?:()=>void;onReady?:()=>void}={events:[],ended:false,onReady:options?.onReady};
   streams.set(requestId,state);
   const abort=()=>{state.ended=true;state.error=new Error("Node stream cancelled");state.wake?.();process.send?.({channel:"worker-cancel",requestId});};
   options?.signal?.addEventListener("abort",abort,{once:true});
   try{
    if(options?.signal?.aborted)throw new Error("Node stream cancelled");
    process.send?.({channel:"worker-request",requestId,envelope,stream:true},error=>{if(error){state.ended=true;state.error=new Error("Infrastructure channel unavailable");state.wake?.();}});
    while(!state.ended || state.events.length){const event=state.events.shift();if(event){yield event;continue;}await new Promise<void>(resolve=>{state.wake=resolve;});}
    if(state.error)throw state.error;
   }finally{options?.signal?.removeEventListener("abort",abort);process.send?.({channel:"worker-cancel",requestId});streams.delete(requestId);}
  },
 });
}
