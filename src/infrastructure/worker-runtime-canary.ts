import {lstat,readFile} from "node:fs/promises";
import type {ProvisionedNode} from "./node-provisioner.js";

/** One startup canary in the Root-owned journal; never an application RPC or idle loop. */
export async function verifyWorkerRuntimeCanary(options:{
 journalPath:string;
 selftest(nodeId:string,generation:number,profile:"baseline"|"browser"|"network"):Promise<unknown>;
 log(message:string):void;
}):Promise<void>{
 const stat=await lstat(options.journalPath);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||stat.size>1024*1024)throw new Error("Invalid runtime canary journal");
 const journal=JSON.parse(await readFile(options.journalPath,"utf8")) as {version:number;nodes:ProvisionedNode[]};
 if(journal.version!==1||!Array.isArray(journal.nodes)||journal.nodes.length>1000)throw new Error("Invalid runtime canary journal");
 const candidates=journal.nodes.filter(node=>node.slot===1&&node.phase!=="retired");
 if(candidates.length!==1)throw new Error("Runtime canary ownership unavailable");
 const node=candidates[0];
 if(!node||!/^[A-Za-z0-9_-]{1,128}$/.test(node.nodeId)||!Number.isSafeInteger(node.generation)||node.generation<1||node.unbound!==true||node.phase!=="deploying"||!node.serviceId||!node.volumeId)throw new Error("Runtime canary must be an unbound provisioned slot");
 for(const profile of ["baseline","browser","network"] as const){
  await options.selftest(node.nodeId,node.generation,profile);
  options.log(`[InfrastructureBoundary] worker_runtime_verified node=${node.nodeId} generation=${node.generation} profile=${profile} joined=true\n`);
 }
}
