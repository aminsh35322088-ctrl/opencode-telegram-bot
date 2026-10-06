import {randomUUID,createHmac,timingSafeEqual} from "node:crypto";
import type {NodeEnvelope,NodeIdentity} from "../control-plane/node-protocol.js";
import {NodeProtocol} from "../control-plane/node-protocol.js";
import type {captureNodeRegistry} from "./node-registry.js";
import type {InfrastructureNodeIdentity} from "./node-registry.js";

const operations=new Set(["health","status","sync-global","session.create","session.get","session.status","session.query","session.messages","session.events","session.delete","question.list","question.reply","run.prepare","run","pause","resume","stop","retire"]);
export class InfrastructureNodeTransport {
 constructor(private readonly registry:ReturnType<typeof captureNodeRegistry>,private readonly protocol:NodeProtocol,private readonly persist:()=>Promise<void>,private readonly fetcher:typeof fetch=fetch){}
 /** Only the root retirement controller retains the previous identity after fencing. */
 async retireFenced(identity:Readonly<InfrastructureNodeIdentity>):Promise<void>{
  const {nodeId,generation,chatId,threadId,sessionId}=identity.binding;
  const signed=this.protocol.sign({version:1,nodeId,generation,chatId,threadId,sessionId,operation:"retire",payload:{},timestamp:Date.now(),nonce:randomUUID().replaceAll("-","")},identity.secret);
  const response=await this.fetcher(new URL("/rpc",identity.endpoint),{method:"POST",body:signed.body,headers:{"content-type":"application/json","x-node-signature":signed.signature},redirect:"error",signal:AbortSignal.timeout(15_000)});
  if(!response.ok)throw new Error("Fenced node retirement failed");
  const reply=await this.protocol.verify(await boundedBody(response,10*1024*1024),response.headers.get("x-node-signature")??"",{nodeId,generation,chatId,threadId},identity.secret);
  if(reply.operation!=="retire" || reply.sessionId!==sessionId || (reply.payload as {ok?:boolean;result?:{retired?:boolean}}).ok!==true || (reply.payload as {result?:{retired?:boolean}}).result?.retired!==true)throw new Error("Fenced node retirement denied");
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
  const {identity,bound,signed}=await this.prepare(envelope);
  const response=await this.fetcher(new URL("/rpc",identity.endpoint),{method:"POST",body:signed.body,headers:{"content-type":"application/json","x-node-signature":signed.signature},redirect:"error",signal:signal??AbortSignal.timeout(45_000)});
  if(!response.ok)throw new Error("Node request failed");
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
async function boundedBody(response:Response,maximum:number):Promise<string>{
 if(!response.body)throw new Error("Missing node response");const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
 try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>maximum)throw new Error("Node response too large");chunks.push(value);}return Buffer.concat(chunks).toString("utf8");}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
