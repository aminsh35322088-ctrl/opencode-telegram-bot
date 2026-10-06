import {InfrastructureRequestError} from "./railway-client.js";
import {createServer} from "node:http";
import type {ChildProcess} from "node:child_process";
import {randomUUID} from "node:crypto";
import {NodeProtocol,type NodeEnvelope} from "../control-plane/node-protocol.js";
import {handleNodeControl} from "../control-plane/node-control.js";
import type {captureNodeRegistry} from "./node-registry.js";
import type {InfrastructureController} from "./node-controller.js";
import {InfrastructureNodeTransport} from "./node-transport.js";

type Registry=ReturnType<typeof captureNodeRegistry>;
/** Root-only gateway. Application sees authenticated envelopes, never signing material. */
export function startNodeGateway(child:ChildProcess,registry:Registry,protocol:NodeProtocol,port:number,controller?:InfrastructureController){
  const pending=new Map<string,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
  const outbound=new Map<string,AbortController>();
  let infrastructureActive=0;
  let applicationReady=false;
  let desiredRevision=0;
  let reconciling=false;
  const transport=new InfrastructureNodeTransport(registry,protocol,()=>registry.persist("/data/.infrastructure/nodes.json"));
  async function syncNodes(){
    if(reconciling)return;reconciling=true;
    try{
      let revision:number;
      do{revision=desiredRevision;
        await Promise.allSettled(registry.metadata().filter(binding=>["ready","available"].includes(binding.status)).map(binding=>transport.request({version:1,nodeId:binding.nodeId,generation:binding.generation,chatId:binding.chatId,threadId:binding.threadId,sessionId:binding.sessionId,operation:"sync-global",payload:{revision},timestamp:Date.now(),nonce:randomUUID()})));
      }while(revision<desiredRevision);
    }finally{reconciling=false;}
  }
  function dispatch(envelope:NodeEnvelope):Promise<unknown>{
    if(pending.size>=32 || !child.connected) return Promise.reject(new Error("Control dispatcher unavailable"));
    return new Promise((resolve,reject)=>{
      const requestId=randomUUID();
      const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error("Control dispatcher timeout"));},30_000);
      pending.set(requestId,{resolve,reject,timer});
      child.send({channel:"node-control",requestId,envelope},error=>{if(error){clearTimeout(timer);pending.delete(requestId);reject(new Error("Control dispatcher unavailable"));}});
    });
  }
  child.on("message",message=>{
    if(!message || typeof message!=="object") return;
    const response=message as {channel?:string;requestId?:string;ok?:boolean;result?:unknown;revision?:number};
    if(response.channel==="control-application-ready"){applicationReady=true;return;}
    if(response.channel==="global-revision" && Number.isSafeInteger(response.revision) && response.revision!>desiredRevision){desiredRevision=response.revision!;void syncNodes();return;}
    if(response.channel!=="node-control-response" || !response.requestId) return;
    const wait=pending.get(response.requestId);if(!wait)return;
    clearTimeout(wait.timer);pending.delete(response.requestId);
    if(response.ok===true)wait.resolve(response.result);else wait.reject(new Error("Control operation failed"));
  });
  child.on("message",async message=>{
    if(!message || typeof message!=="object")return;
    const input=message as {channel?:string;requestId?:string;envelope?:NodeEnvelope;stream?:boolean;operation?:string;nodeId?:string;generation?:number};
    if(typeof input.requestId!=="string" || input.requestId.length>128)return;
    if(input.channel==="infrastructure-request"){
      if(!controller||infrastructureActive>=4||!input.operation||!input.nodeId||!input.generation){child.send({channel:"infrastructure-response",requestId:input.requestId,ok:false});return;}
      infrastructureActive++;
      try{const result=await controller.request(input.operation,input.nodeId,input.generation);child.send({channel:"infrastructure-response",requestId:input.requestId,ok:true,result});}
      catch(error){
        const category=error instanceof InfrastructureRequestError?error.category:"verification";
        const http=error instanceof InfrastructureRequestError?error.status:0;
        const stage=error instanceof InfrastructureRequestError?error.operation:"verification";
        process.stdout.write(`[InfrastructureBoundary] worker_operation_failed stage=${stage} category=${category} http=${http}\n`);
        child.send({channel:"infrastructure-response",requestId:input.requestId,ok:false,errorCode:category,httpStatus:http});
      }
      finally{infrastructureActive--;}
      return;
    }
    if(input.channel==="worker-cancel"){outbound.get(input.requestId)?.abort();return;}
    if(input.channel!=="worker-request" || !input.envelope)return;
    if(outbound.has(input.requestId)||outbound.size>=8){child.send({channel:"worker-response",requestId:input.requestId,ok:false});return;}
    const abort=new AbortController();outbound.set(input.requestId,abort);
    const deadline=input.stream?undefined:setTimeout(()=>abort.abort(),45_000);
    try{
      if(input.stream){
        for await(const event of transport.stream(input.envelope,abort.signal,()=>{child.send({channel:"worker-stream-ready",requestId:input.requestId});})){
          await new Promise<void>((resolve,reject)=>child.send({channel:"worker-event",requestId:input.requestId,event},error=>error?reject(error):resolve()));
        }
        child.send({channel:"worker-stream-end",requestId:input.requestId,ok:true});
      }else{
        const result=await transport.request(input.envelope,abort.signal);
        child.send({channel:"worker-response",requestId:input.requestId,ok:true,result});
      }
    }catch{child.send({channel:input.stream?"worker-stream-end":"worker-response",requestId:input.requestId,ok:false});}
    finally{if(deadline)clearTimeout(deadline);outbound.delete(input.requestId);}
  });
  const server=createServer(async(request,response)=>{
    response.setHeader("cache-control","no-store");
    if(request.url==="/health" && request.method==="GET"){const ready=child.connected&&applicationReady;response.writeHead(ready?200:503);response.end(JSON.stringify({status:ready?"healthy":"unavailable"}));return;}
    if(request.url!=="/node-control" || request.method!=="POST"){response.writeHead(404);response.end();return;}
    try{
      let size=0;const chunks:Buffer[]=[];
      for await(const chunk of request){const buffer=Buffer.from(chunk);size+=buffer.length;if(size>10*1024*1024)throw new Error("Request too large");chunks.push(buffer);}
      const signature=request.headers["x-node-signature"];
      if(typeof signature!=="string")throw new Error("Signature required");
      const result=await handleNodeControl(Buffer.concat(chunks).toString("utf8"),signature,{protocol,
        resolveIdentity:async nodeId=>{const identity=await registry.resolve(nodeId);return identity?{binding:identity.binding,secret:identity.secret}:null;},dispatch});
      response.writeHead(200,{"content-type":"application/json","x-node-signature":result.signature});response.end(result.body);
    }catch{response.writeHead(403,{"content-type":"application/json"});response.end(JSON.stringify({error:"Node request denied"}));}
  });
  server.requestTimeout=20_000;server.headersTimeout=10_000;server.keepAliveTimeout=1000;
  server.maxConnections=32;
  server.listen(port,"0.0.0.0");
  return ()=>{server.close();for(const abort of outbound.values())abort.abort();outbound.clear();for(const wait of pending.values()){clearTimeout(wait.timer);wait.reject(new Error("Control gateway closed"));}pending.clear();};
}
