import type {NodeControlBinding} from "../control-plane/node-control.js";
import {lstat,readFile,mkdir,open,rename} from "node:fs/promises";
import {dirname} from "node:path";

export interface InfrastructureNodeIdentity {binding: NodeControlBinding;endpoint:string;secret:string;}
/** Root-only identity owner. Consume environment before any application imports. */
export function captureNodeRegistry(environment:NodeJS.ProcessEnv) {
  const raw=environment.CONTROL_NODE_REGISTRY;
  delete environment.CONTROL_NODE_REGISTRY;
  const identities=new Map<string,InfrastructureNodeIdentity>();
  if(raw){
    const parsed:unknown=JSON.parse(raw);
    if(!Array.isArray(parsed) || parsed.length>1000) throw new Error("Invalid infrastructure node registry");
    const topics=new Set<string>();
    for(const candidate of parsed){
      const identity=candidate as InfrastructureNodeIdentity;
      const binding=identity?.binding;
      const endpoint=new URL(identity.endpoint);
      if(!binding || !binding.nodeId || !Number.isSafeInteger(binding.generation) || binding.generation<1 ||
         !Number.isSafeInteger(binding.chatId) || !Number.isSafeInteger(binding.threadId) || binding.threadId<=1 ||
         typeof identity.secret!=="string" || identity.secret.length<64 || !/^[a-zA-Z0-9_-]+$/.test(identity.secret) ||
         endpoint.protocol!=="https:" || !endpoint.hostname.endsWith(".up.railway.app") || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname!=="/") throw new Error("Invalid infrastructure node identity");
      const topic=`${binding.chatId}:${binding.threadId}`;
      if(identities.has(binding.nodeId) || (binding.status!=="retired" && topics.has(topic))) throw new Error("Duplicate infrastructure node identity");
      if(binding.status!=="retired")topics.add(topic);identities.set(binding.nodeId,structuredClone(identity));
    }
    if(topics.size>4)throw new Error("Infrastructure node capacity exceeded");
  }
  return {
    metadata:()=>Array.from(identities.values(),({binding,endpoint})=>({...binding,endpoint})),
    resolve:async(nodeId:string)=>{const identity=identities.get(nodeId);return identity ? structuredClone(identity):null;},
    install:(identity:InfrastructureNodeIdentity)=>{
      const checked=captureNodeRegistry({CONTROL_NODE_REGISTRY:JSON.stringify([identity])});checked.dispose();
      const existing=identities.get(identity.binding.nodeId);
      if(existing && identity.binding.generation<existing.binding.generation)throw new Error("Stale infrastructure identity");
      if(identity.binding.status!=="retired" && (!existing || existing.binding.status==="retired") && Array.from(identities.values()).filter(item=>item.binding.status!=="retired").length>=4)throw new Error("Infrastructure node capacity exceeded");
      if(identity.binding.status!=="retired" && Array.from(identities.values()).some(item=>item.binding.nodeId!==identity.binding.nodeId && item.binding.chatId===identity.binding.chatId && item.binding.threadId===identity.binding.threadId && item.binding.status!=="retired"))throw new Error("Duplicate infrastructure topic ownership");
      identities.set(identity.binding.nodeId,structuredClone(identity));
    },
    load:async(filename:string)=>{
      try{const stat=await lstat(filename);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==0||(stat.mode&0o077)!==0)throw new Error("Invalid infrastructure identity store");
        const loaded=captureNodeRegistry({CONTROL_NODE_REGISTRY:await readFile(filename,"utf8")});
        for(const metadata of loaded.metadata()){
          const identity=await loaded.resolve(metadata.nodeId);if(!identity)continue;
          const existing=identities.get(metadata.nodeId);
          if(existing && existing.binding.generation>metadata.generation)continue;
          if(existing && existing.binding.generation===metadata.generation && existing.secret!==identity.secret)throw new Error("Conflicting infrastructure identity");
          identities.set(metadata.nodeId,identity);
        }loaded.dispose();
        const checked=captureNodeRegistry({CONTROL_NODE_REGISTRY:JSON.stringify(Array.from(identities.values()))});checked.dispose();
      }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    },
    persist:async(filename:string)=>{
      await mkdir(dirname(filename),{recursive:true,mode:0o700});
      const file=await open(`${filename}.tmp`,"w",0o600);
      try{await file.writeFile(JSON.stringify(Array.from(identities.values())));await file.sync();}finally{await file.close();}
      await rename(`${filename}.tmp`,filename);
      const directory=await open(dirname(filename),"r");try{await directory.sync();}finally{await directory.close();}
    },
    dispose:()=>identities.clear(),
  };
}
