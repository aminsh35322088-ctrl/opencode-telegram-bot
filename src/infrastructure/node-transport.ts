import {randomUUID,createHmac,timingSafeEqual} from "node:crypto";
import type {NodeEnvelope,NodeIdentity} from "../control-plane/node-protocol.js";
import type {NodeBinding} from "../control-plane/node-bindings.js";
import {NodeProtocol} from "../control-plane/node-protocol.js";
import type {captureNodeRegistry} from "./node-registry.js";
import type {InfrastructureNodeIdentity} from "./node-registry.js";

import {WorkerProvisioningError} from "./worker-provisioning-driver.js";

export type WorkerBoundaryCheck="replay"|"foreign-topic"|"stale-generation";
export class WorkerBoundaryVerificationError extends Error{
 constructor(readonly check:WorkerBoundaryCheck,readonly status:number){super("Worker boundary verification failed");}
}
const operations=new Set(["health","status","sync-global","session.create","session.get","session.status","session.query","session.messages","session.events","session.delete","session.compact","models.list","agents.list","commands.list","permission.list","permission.reply","question.list","question.reply","question.reject","run.prepare","run","pause","resume","stop","retire"]);
export class InfrastructureNodeTransport {
 constructor(private readonly registry:ReturnType<typeof captureNodeRegistry>,private readonly protocol:NodeProtocol,private readonly persist:()=>Promise<void>,private readonly fetcher:typeof fetch=fetch,private readonly wait:(milliseconds:number)=>Promise<void>=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds))){}
 /** Root-only fixed canary for an available, unassigned Worker. Not a model/IPC operation. */
 async runtimeSelftest(nodeId:string,generation:number,profile:"baseline"|"browser"|"network"):Promise<{profile:"baseline"|"browser"|"network";joined:true;success:true;runId:string}>{
  if(!["baseline","browser","network"].includes(profile))throw new Error("Invalid runtime selftest profile");
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(new Error("Runtime selftest deadline exceeded")),240_000);
  let response:Response|undefined;
  let abort!:()=>void;
  const expired=new Promise<never>((_resolve,reject)=>{abort=()=>reject(controller.signal.reason);controller.signal.addEventListener("abort",abort,{once:true});});
  const requireScope=(identity:Readonly<InfrastructureNodeIdentity>|null,original?:Readonly<InfrastructureNodeIdentity>)=>{
   if(!identity||identity.binding.nodeId!==nodeId||identity.binding.generation!==generation||!["available","pool-provisioning"].includes(identity.binding.status)||identity.binding.chatId!==0||identity.binding.threadId!==0||identity.binding.sessionId!==undefined||(original&&(identity.endpoint!==original.endpoint||identity.secret!==original.secret)))throw new Error("Runtime selftest scope denied");
   return identity;
  };
  try{
   return await Promise.race([expired,(async()=>{
    const identity=requireScope(await this.registry.resolve(nodeId));
    controller.signal.throwIfAborted();
    const signed=this.protocol.sign({version:1,nodeId,generation,chatId:0,threadId:0,operation:"runtime.selftest",payload:{profile},timestamp:Date.now(),nonce:randomUUID().replaceAll("-","")},identity.secret);
    response=await this.fetcher(new URL("/rpc",identity.endpoint),{method:"POST",body:signed.body,headers:{"content-type":"application/json","x-node-signature":signed.signature},redirect:"error",signal:controller.signal});
    controller.signal.throwIfAborted();
    if(!response.ok){await response.body?.cancel();throw new Error("Runtime selftest request failed");}
    const body=await boundedBody(response,64*1024,controller.signal);
    controller.signal.throwIfAborted();
    const reply=await this.protocol.verify(body,response.headers.get("x-node-signature")??"",{nodeId,generation,chatId:0,threadId:0},identity.secret);
    controller.signal.throwIfAborted();
    requireScope(await this.registry.resolve(nodeId),identity);
    controller.signal.throwIfAborted();
    const payload=reply.payload as {ok?:unknown;result?:{profile?:unknown;joined?:unknown;success?:unknown;runId?:unknown}}|null;
    const result=payload?.result;
    if(reply.operation!=="runtime.selftest"||reply.sessionId!==undefined||payload?.ok!==true||!result||result.profile!==profile||result.joined!==true||result.success!==true||typeof result.runId!=="string"||!/^[a-f0-9]{48}$/.test(result.runId))throw new Error("Runtime selftest response proof denied");
    return {profile,joined:true as const,success:true as const,runId:result.runId};
   })()]);
  }finally{
   clearTimeout(timer);controller.signal.removeEventListener("abort",abort);
   if(controller.signal.aborted)void response?.body?.cancel().catch(()=>{});
  }
 }
 /** Bounded reconciliation evidence only. Never admits execution or exposes signing material. */
 async probeUnboundBoundary(nodeId:string,generation:number):Promise<{health:true;replayRejected:true;foreignTopicRejected:true;staleGenerationRejected:true}>{
  const identity=await this.registry.resolve(nodeId);
  if(!identity||identity.binding.generation!==generation||identity.binding.chatId!==0||identity.binding.threadId!==0||!["available","pool-provisioning"].includes(identity.binding.status))throw new Error("Unbound boundary probe scope denied");
  const envelope:NodeEnvelope={version:1,nodeId,generation,chatId:0,threadId:0,operation:"health",payload:{},timestamp:Date.now(),nonce:randomUUID().replaceAll("-","")};
  const send=async(signed:{body:string;signature:string})=>{
   const current=await this.registry.resolve(nodeId);
   if(!current||current.binding.generation!==generation||!["available","pool-provisioning"].includes(current.binding.status)||current.binding.chatId!==0||current.binding.threadId!==0)throw new Error("Unbound boundary probe scope changed");
   try{
    return await this.fetcher(new URL("/rpc",identity.endpoint),{method:"POST",body:signed.body,headers:{"content-type":"application/json","x-node-signature":signed.signature},redirect:"error",signal:AbortSignal.timeout(45_000)});
   }catch{throw new WorkerProvisioningError("provisioning_pending");}
  };
  const signed=this.protocol.sign(envelope,identity.secret);
  const first=await send(signed);
  if(!first.ok){
   await first.body?.cancel();
   if([404,408,429,502,503,504].includes(first.status))throw new WorkerProvisioningError("provisioning_pending");
   throw new Error("Worker boundary health failed");
  }
  const reply=await this.protocol.verify(await boundedBody(first,64*1024),first.headers.get("x-node-signature")??"",{nodeId,generation,chatId:0,threadId:0},identity.secret);
  const result=reply.payload as {ok?:boolean;result?:{ready?:boolean}};
  if(reply.operation!=="health"||reply.sessionId!==undefined||result.ok!==true||result.result?.ready!==true)throw new Error("Worker boundary health denied");
  const rejected=async(check:WorkerBoundaryCheck,request:{body:string;signature:string})=>{
   const response=await send(request);
   // A proxy failure/timeout is not evidence of authentication enforcement.
   const denied=response.status===401||response.status===403;
   const status=response.status;
   await response.body?.cancel();
   if([404,408,429,502,503,504].includes(status))throw new WorkerProvisioningError("provisioning_pending");
   if(!denied)throw new WorkerBoundaryVerificationError(check,status);
  };
  await rejected("replay",signed);
  await rejected("foreign-topic",this.protocol.sign({...envelope,chatId:1,threadId:2,nonce:randomUUID().replaceAll("-","")},identity.secret));
  await rejected("stale-generation",this.protocol.sign({...envelope,generation:generation+1,nonce:randomUUID().replaceAll("-","")},identity.secret));
  return {health:true,replayRejected:true,foreignTopicRejected:true,staleGenerationRejected:true};
 }
 /** Only the root retirement controller retains the previous identity after fencing. */
 async retireFenced(identity:Readonly<InfrastructureNodeIdentity>,sanitize=false):Promise<void>{
  const {nodeId,generation,chatId,threadId,sessionId}=identity.binding;
  const signed=this.protocol.sign({version:1,nodeId,generation,chatId,threadId,sessionId,operation:"retire",payload:sanitize?{sanitize:true}:{},timestamp:Date.now(),nonce:randomUUID().replaceAll("-","")},identity.secret);
  const response=await this.fetcher(new URL("/rpc",identity.endpoint),{method:"POST",body:signed.body,headers:{"content-type":"application/json","x-node-signature":signed.signature},redirect:"error",signal:AbortSignal.timeout(15_000)});
  if(!response.ok)throw new Error("Fenced node retirement failed");
  const reply=await this.protocol.verify(await boundedBody(response,10*1024*1024),response.headers.get("x-node-signature")??"",{nodeId,generation,chatId,threadId},identity.secret);
  const result=(reply.payload as {ok?:boolean;result?:{retired?:boolean;sanitized?:boolean}});
  if(reply.operation!=="retire" || reply.sessionId!==sessionId || result.ok!==true || result.result?.retired!==true || (sanitize&&result.result?.sanitized!==true))throw new Error("Fenced node retirement denied");
 }
 async rotateFenced(identity:Readonly<InfrastructureNodeIdentity>,bootstrapToken:string,target:NodeIdentity):Promise<void>{
  const {nodeId,generation,chatId,threadId}=identity.binding;
  if(typeof bootstrapToken!=="string"||!/^[A-Za-z0-9_-]{48,128}$/.test(bootstrapToken)||target.nodeId!==nodeId||target.generation!==generation+1||(target.chatId===0)!==(target.threadId===0))throw new Error("Invalid binding rotation request");
  const signed=this.protocol.sign({version:1,nodeId,generation,chatId,threadId,operation:"binding.rotate",payload:{bootstrapToken},timestamp:Date.now(),nonce:randomUUID().replaceAll("-","")},identity.secret);
  const response=await this.fetcher(new URL("/rpc",identity.endpoint),{method:"POST",body:signed.body,headers:{"content-type":"application/json","x-node-signature":signed.signature},redirect:"error",signal:AbortSignal.timeout(20_000)});
  if(!response.ok)throw new Error("Fenced binding rotation failed");
  const reply=await this.protocol.verify(await boundedBody(response,1024*1024),response.headers.get("x-node-signature")??"",{nodeId,generation,chatId,threadId},identity.secret);
  const payload=reply.payload as {ok?:boolean;result?:{rotated?:boolean;identity?:NodeIdentity}};
  const rotated=payload.result?.identity;
  if(reply.operation!=="binding.rotate"||reply.sessionId!==undefined||payload.ok!==true||payload.result?.rotated!==true||!rotated||rotated.nodeId!==target.nodeId||rotated.generation!==target.generation||rotated.chatId!==target.chatId||rotated.threadId!==target.threadId)throw new Error("Fenced binding rotation denied");
 }
 /** Exact-session idle probe used only for safe Worker image rollout; uncertainty always means busy. */
 async probeIdle(binding:Readonly<NodeBinding>):Promise<boolean>{
  if(binding.status!=="ready"||binding.chatId===0||binding.threadId<=1||!binding.sessionId)return false;
  try{
   const response=await this.request({version:1,nodeId:binding.nodeId,generation:binding.generation,chatId:binding.chatId,threadId:binding.threadId,sessionId:binding.sessionId,operation:"status",payload:{},timestamp:Date.now(),nonce:randomUUID().replaceAll("-","")},AbortSignal.timeout(10_000));
   const payload=response as {ok?:unknown;result?:{continuation?:unknown;externalRunId?:unknown}}|null;
   return payload?.ok===true&&payload.result?.continuation==="idle"&&payload.result.externalRunId===null;
  }catch{return false;}
 }
 private async prepare(envelope:NodeEnvelope){
  const identity=await this.registry.resolve(envelope.nodeId);
  if(!identity || identity.binding.status==="retiring" || identity.binding.status==="retired" || !operations.has(envelope.operation))throw new Error("Node transport denied");
  const {nodeId,generation,chatId,threadId}=identity.binding;
  if(chatId===0 && threadId===0 && !["health","status","sync-global"].includes(envelope.operation))throw new Error("Unbound Worker operation denied");
  const bound:NodeIdentity={nodeId,generation,chatId,threadId};
  if(Object.entries(bound).some(([key,value])=>envelope[key as keyof NodeIdentity]!==value))throw new Error("Node identity denied");
  if(!["health","status","sync-global","session.create","retire"].includes(envelope.operation) && (!identity.binding.sessionId || envelope.sessionId!==identity.binding.sessionId))throw new Error("Node session denied");
  const signed=this.protocol.sign({...envelope,timestamp:Date.now(),nonce:randomUUID().replaceAll("-","")},identity.secret);
  return {identity,bound,signed};
 }
 async request(envelope:NodeEnvelope,signal?:AbortSignal):Promise<unknown>{
  const deadline=signal??AbortSignal.timeout(45_000);
  const retryable=envelope.operation==="sync-global"&&envelope.chatId===0&&envelope.threadId===0&&envelope.sessionId===undefined;
  for(let attempt=0;attempt<2;attempt++){
   deadline.throwIfAborted();
   const {identity,bound,signed}=await this.prepare(envelope);
   const response=await this.fetcher(new URL("/rpc",identity.endpoint),{method:"POST",body:signed.body,headers:{"content-type":"application/json","x-node-signature":signed.signature},redirect:"error",signal:deadline});
   if(!response.ok){
    let transient=[502,503,504].includes(response.status);
    if(response.status===409&&retryable){
     const rejection=await this.protocol.verify(await boundedBody(response,64*1024),response.headers.get("x-node-signature")??"",bound,identity.secret);
     const payload=rejection.payload as {ok?:boolean;error?:string};
     transient=rejection.operation===envelope.operation&&rejection.sessionId===undefined&&payload.ok===false&&payload.error==="operation rejected";
    }else await response.body?.cancel();
    if(!retryable||attempt!==0||!transient)throw new Error("Node request failed");
    // Deployment promotion may briefly make the Control callback unroutable.
    // Snapshot sync is idempotent; only this unbound startup operation retries.
    await this.wait(2000);continue;
   }
  const body=await boundedBody(response,10*1024*1024);
  const reply=await this.protocol.verify(body,response.headers.get("x-node-signature")??"",bound,identity.secret);
  if(reply.operation!==envelope.operation || reply.sessionId!==envelope.sessionId)throw new Error("Node response scope mismatch");
  if(envelope.operation==="session.create"){
   const payload=reply.payload as {ok?:boolean;result?:{sessionId?:string}};
   if(payload.ok && typeof payload.result?.sessionId==="string"){
    this.registry.install({...identity,binding:{...identity.binding,sessionId:payload.result.sessionId}});await this.persist();
   }
  }
  return reply.payload;
  }
  throw new Error("Node request failed");
 }
 async *stream(envelope:NodeEnvelope,signal?:AbortSignal,onReady?:()=>void):AsyncIterable<NodeEnvelope>{
  if(envelope.operation!=="session.events")throw new Error("Unsupported node stream");
  const {identity,bound,signed}=await this.prepare(envelope);
  const response=await this.fetcher(new URL("/rpc",identity.endpoint),{method:"POST",body:signed.body,headers:{"content-type":"application/json","x-node-signature":signed.signature},redirect:"error",signal});
  if(!response.ok || !response.body)throw new Error("Node stream failed");
  const acknowledgment=response.headers.get("x-node-stream-ready")??"";
  const expected=createHmac("sha256",identity.secret).update(`${signed.body}\nstream-ready`).digest();
  if(!/^[a-f0-9]{64}$/.test(acknowledgment) || !timingSafeEqual(expected,Buffer.from(acknowledgment,"hex")))throw new Error("Unsigned node stream readiness");
  if(!envelope.sessionId || typeof (envelope.payload as {runId?:unknown})?.runId!=="string")throw new Error("Node stream run scope required");
  const requestNonce=(JSON.parse(signed.body) as NodeEnvelope).nonce;
  const verifyFrame=this.protocol.streamVerifier(bound,identity.secret,{nonce:requestNonce,sessionId:envelope.sessionId,runId:(envelope.payload as {runId:string}).runId});
  onReady?.();
  const reader=response.body.getReader();const decoder=new TextDecoder();let buffer="";
  try{
   while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});if(Buffer.byteLength(buffer)>10*1024*1024)throw new Error("Node stream frame too large");
    let index:number;
    while((index=buffer.indexOf("\n\n"))>=0){const frame=buffer.slice(0,index);buffer=buffer.slice(index+2);const data=frame.split("\n").filter(line=>line.startsWith("data:")).map(line=>line.slice(5).trimStart()).join("\n");if(!data)continue;
     const signedFrame=JSON.parse(data) as {body:string;signature:string};
     if(typeof signedFrame.body!=="string" || typeof signedFrame.signature!=="string")throw new Error("Unsigned node frame");
     const event=verifyFrame(signedFrame.body,signedFrame.signature);
     const current=await this.registry.resolve(bound.nodeId);
     if(!current || current.binding.generation!==bound.generation || current.binding.status!=="ready" || event.sessionId!==envelope.sessionId || event.operation!=="session.event")throw new Error("Stale node stream");
     yield event;
    }
   }
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 }
}
async function boundedBody(response:Response,maximum:number,signal?:AbortSignal):Promise<string>{
 if(!response.body)throw new Error("Missing node response");const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
 const abort=()=>{void reader.cancel(signal?.reason).catch(()=>{});};signal?.addEventListener("abort",abort,{once:true});
 try{while(true){signal?.throwIfAborted();const {value,done}=await reader.read();signal?.throwIfAborted();if(done)break;size+=value.length;if(size>maximum)throw new Error("Node response too large");chunks.push(value);}return Buffer.concat(chunks).toString("utf8");}
 finally{signal?.removeEventListener("abort",abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
