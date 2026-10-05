import {dispatchAuthenticatedNodeControl} from "./node-dispatch.js";
import type {NodeEnvelope} from "./node-protocol.js";
import {installInfrastructureTransport} from "./application-transport.js";
import {onGlobalRevision} from "./global-state.js";

let installed=false;
/** The inherited IPC descriptor is exposed only to final Bot startup, not bootstrap probes. */
export function installControlApplicationChannel():void{
  if(installed || !process.send)return;installed=true;
  installInfrastructureTransport();
  onGlobalRevision(async snapshot=>{process.send?.({channel:"global-revision",revision:snapshot.revision});});
  let active=0;
  process.on("message",async(message:unknown)=>{
    if(!message || typeof message!=="object")return;
    const input=message as {channel?:string;requestId?:string;envelope?:NodeEnvelope};
    if(input.channel!=="node-control" || typeof input.requestId!=="string" || !input.envelope)return;
    if(active>=32){process.send?.({channel:"node-control-response",requestId:input.requestId,ok:false});return;}
    active++;
    try{const result=await dispatchAuthenticatedNodeControl(input.envelope);process.send?.({channel:"node-control-response",requestId:input.requestId,ok:true,result});}
    catch{process.send?.({channel:"node-control-response",requestId:input.requestId,ok:false});}
    finally{active--;}
  });
}
