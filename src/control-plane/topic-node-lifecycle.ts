import {logger} from "../utils/logger.js";
import type { Api } from "grammy";
import type { Session } from "@opencode-ai/sdk/v2";
import { nodeBindings, NodeBindingStore, type NodeBinding } from "./node-bindings.js";
import { readGlobalSnapshot } from "./global-state.js";
import {WorkerProvisioningError,type ProvisionedNode} from "../infrastructure/worker-provisioning-driver.js";
import { requestInfrastructure, requestNodeLifecycle } from "./application-transport.js";
import { saveTelegramTopicBinding, listTelegramTopicBindings, type TelegramTopicBinding } from "../app/services/telegram-topic-store.js";
import { getNextManagedChatTitle } from "../app/services/telegram-topic-session-service.js";

let creationEnabled = false;
/** Explicit rollout gate. Existing local Topics are not migrated by enabling creation. */
export function setTopicNodeCreationEnabled(enabled: boolean): void { creationEnabled = enabled; }
export function isTopicNodeCreationEnabled(): boolean { return creationEnabled; }
interface LifecycleDependencies {
  bindings: NodeBindingStore;
  infrastructure(operation:"provision"|"retire"|"reconcile",nodeId:string,generation:number):Promise<ProvisionedNode>;
  node(binding:NodeBinding,operation:string,payload:unknown):Promise<unknown>;
  snapshot():Promise<{revision:number;hash:string}>;
  now():number;
  wait(milliseconds:number):Promise<void>;
}
export class TopicNodeLifecycle {
  private poolFlight:Promise<NodeBinding[]>|undefined;
  private readonly flights=new Map<string,Promise<{binding:NodeBinding;session:Session}>>();
  constructor(private readonly dependencies:LifecycleDependencies={bindings:nodeBindings,infrastructure:requestInfrastructure,node:requestNodeLifecycle,snapshot:readGlobalSnapshot,now:Date.now,wait:milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds))}) {}
  private async rpc<T>(binding:NodeBinding,operation:string,payload:unknown={}):Promise<T> {
    const response=await this.dependencies.node(binding,operation,payload) as {ok?:boolean;result?:T};
    if(response?.ok!==true)throw new Error("Node lifecycle request failed");
    return response.result as T;
  }
  /** Reconcile existing unbound Workers; New Chat allocates additional capacity lazily. */
  bootstrapPool(warmCapacity=0):Promise<NodeBinding[]> {
    if(this.poolFlight)return this.poolFlight;
    const operation=this.preparePool(warmCapacity).finally(()=>{if(this.poolFlight===operation)this.poolFlight=undefined;});
    this.poolFlight=operation;return operation;
  }
  private async waitReady(binding:NodeBinding,status:'provisioning'|'pool-provisioning'|'available',expected?:ProvisionedNode):Promise<void> {
    const deadline=this.dependencies.now()+300_000;
    let delay=1_000;
    while(true) {
      let health:{ready:boolean;runtime?:{telegramCoreCommit:string;telegramCoreVersion:string}}|undefined;
      try {health=await this.rpc(binding,'health');} catch { /* deployment/wake may still be underway */ }
      if(health?.ready){
        if(expected?.image&&(health.runtime?.telegramCoreCommit!==expected.runtimeCommit||health.runtime?.telegramCoreVersion!==expected.runtimeVersion))throw new WorkerProvisioningError("image_mismatch");
        if(expected?.image)logger.info(`[WorkerImage] node=${binding.nodeId} generation=${binding.generation} image=${expected.image} actualCommit=${health.runtime!.telegramCoreCommit} actualVersion=${health.runtime!.telegramCoreVersion}`);
        break;
      }
      if(this.dependencies.now()>=deadline)throw new Error("Topic node readiness timed out");
      await this.dependencies.wait(Math.min(delay,Math.max(0,deadline-this.dependencies.now())));delay=Math.min(delay*2,10_000);
      const current=(await this.dependencies.bindings.list()).find(item=>item.nodeId===binding.nodeId);
      if(!current||current.generation!==binding.generation||current.status!==status||current.chatId!==binding.chatId||current.threadId!==binding.threadId)throw new Error("Topic node generation changed during readiness");
    }
  }
  private async syncGlobal(binding:NodeBinding):Promise<NodeBinding> {
    for(let attempt=0;attempt<3;attempt++) {
      const desired=await this.dependencies.snapshot();
      const applied=await this.rpc<{revision:number;hash:string}>(binding,'sync-global',{revision:desired.revision});
      if(!Number.isSafeInteger(applied.revision)||applied.revision<desired.revision||(applied.revision===desired.revision&&applied.hash!==desired.hash))throw new Error("Node global snapshot verification failed");
      const latest=await this.dependencies.snapshot();
      if(latest.revision===applied.revision&&latest.hash===applied.hash)return binding.currentRevision===applied.revision?binding:this.dependencies.bindings.update(binding.nodeId,binding.generation,{currentRevision:applied.revision});
    }
    throw new Error("Global state changed repeatedly during bootstrap; retry Topic readiness");
  }
  private async preparePool(warmCapacity:number):Promise<NodeBinding[]> {
    const slots=await this.dependencies.bindings.ensurePoolSlots(warmCapacity);
    for(let binding of slots) {
      // Previously prepared or already claimed slots keep their identity/resources.
      if(binding.chatId!==0||binding.threadId!==0)continue;
      if(binding.status==='available'){
        try{
          await this.waitReady(binding,'available');
          binding=await this.syncGlobal(binding);
          await this.dependencies.infrastructure('reconcile',binding.nodeId,binding.generation);
        }catch(error){
          const current=(await this.dependencies.bindings.list()).find(item=>item.nodeId===binding.nodeId);
          if(current?.generation===binding.generation&&current.chatId===0&&current.threadId===0&&current.status==='available')await this.dependencies.bindings.update(binding.nodeId,binding.generation,{status:'pool-provisioning'});
          throw error;
        }
        continue;
      }
      if(!['pool-reserved','pool-provisioning'].includes(binding.status))throw new Error("Invalid unbound Worker bootstrap state");
      const generation=binding.generation;
      binding=await this.dependencies.bindings.update(binding.nodeId,generation,{status:'pool-provisioning'});
      try {
        const provisioned=await this.dependencies.infrastructure('provision',binding.nodeId,generation);
        if(provisioned.nodeId!==binding.nodeId||provisioned.generation!==generation||!provisioned.endpoint||!provisioned.serviceId||!provisioned.volumeId)throw new Error("Incomplete provisioned node identity");
        binding=await this.dependencies.bindings.update(binding.nodeId,generation,{projectId:provisioned.projectId,serviceId:provisioned.serviceId,volumeId:provisioned.volumeId,endpoint:provisioned.endpoint});
        await this.waitReady(binding,'pool-provisioning',provisioned);
        binding=await this.syncGlobal(binding);
        binding=await this.dependencies.bindings.update(binding.nodeId,generation,{status:'available'});
        await this.dependencies.infrastructure('reconcile',binding.nodeId,generation);
      }catch(error){
        const current=(await this.dependencies.bindings.list()).find(item=>item.nodeId===binding.nodeId);
        if(current?.generation===generation&&current.chatId===0&&current.threadId===0&&current.status==='available')await this.dependencies.bindings.update(binding.nodeId,generation,{status:'pool-provisioning'});
        throw error;
      }
    }
    return (await this.dependencies.bindings.list()).filter(binding=>binding.status!=='retired').sort((a,b)=>a.slot!-b.slot!);
  }
  ensureReady(chatId:number,threadId:number,directory:string):Promise<{binding:NodeBinding;session:Session}> {
    const key=`${chatId}:${threadId}`;const existing=this.flights.get(key);if(existing)return existing;
    const operation=this.prepare(chatId,threadId,directory).finally(()=>{if(this.flights.get(key)===operation)this.flights.delete(key);});
    this.flights.set(key,operation);return operation;
  }
  private async prepare(chatId:number,threadId:number,directory:string):Promise<{binding:NodeBinding;session:Session}> {
    let binding=await this.dependencies.bindings.reserve(chatId,threadId);
    if(binding.status==='retiring')throw new Error("Topic node is being retired");
    const generation=binding.generation;
    try {
      if(binding.status!=='ready') {
        binding=await this.dependencies.bindings.update(binding.nodeId,generation,{status:'provisioning'});
        const provisioned=await this.dependencies.infrastructure('provision',binding.nodeId,generation);
        if(provisioned.nodeId!==binding.nodeId||provisioned.generation!==generation||!provisioned.endpoint||!provisioned.serviceId||!provisioned.volumeId)throw new Error("Incomplete provisioned node identity");
        binding=await this.dependencies.bindings.update(binding.nodeId,generation,{projectId:provisioned.projectId,serviceId:provisioned.serviceId,volumeId:provisioned.volumeId,endpoint:provisioned.endpoint});
        await this.waitReady(binding,'provisioning',provisioned);
      }
      binding=await this.syncGlobal(binding);
      const created=await this.rpc<{sessionId:string}>(binding,'session.create');
      if(!created.sessionId||typeof created.sessionId!=='string')throw new Error("Node returned invalid session");
      binding=await this.dependencies.bindings.update(binding.nodeId,generation,{sessionId:created.sessionId});
      const session=await this.rpc<Session>(binding,'session.get');
      if(session.id!==created.sessionId||typeof session.title!=='string')throw new Error("Node session identity mismatch");
      binding=await this.dependencies.bindings.update(binding.nodeId,generation,{status:'ready'});
      await this.dependencies.infrastructure('reconcile',binding.nodeId,generation);
      return {binding,session:{...session,directory}};
    }catch(error){
      const current=await this.dependencies.bindings.find(chatId,threadId);
      if(current?.generation===generation&&current.status!=='retiring')await this.dependencies.bindings.update(binding.nodeId,generation,{status:'failed'});
      throw error;
    }
  }
  async retire(chatId:number,threadId:number):Promise<boolean> {
    let binding=await this.dependencies.bindings.find(chatId,threadId);
    if(!binding)return false;
    if(binding.status!=='retiring')binding=await this.dependencies.bindings.fence(binding.nodeId,binding.generation);
    // Root fences its registry and aborts/retires Core before deleting owned resources.
    const retired=await this.dependencies.infrastructure('retire',binding.nodeId,binding.generation);
    if(retired.nodeId!==binding.nodeId||retired.phase!=='retired')throw new Error("Infrastructure retirement not confirmed");
    await this.dependencies.bindings.update(binding.nodeId,binding.generation,{status:'retired'});return true;
  }
}
export const topicNodeLifecycle=new TopicNodeLifecycle();
const chatCreations=new Map<number,Promise<unknown>>();
export function createRemoteTopicSession(api:Api,chatId:number,directory:string):Promise<{binding:TelegramTopicBinding;session:Session}> {
  const previous=chatCreations.get(chatId)??Promise.resolve();
  const operation=previous.catch(()=>undefined).then(async()=>{
    const title=getNextManagedChatTitle(await listTelegramTopicBindings(),chatId);
    const topic=await api.raw.createForumTopic({chat_id:chatId,name:title});
    if(!topic.message_thread_id)throw new Error("Telegram Topic identity missing");
    const threadId=topic.message_thread_id;
    try {
      const ready=await topicNodeLifecycle.ensureReady(chatId,threadId,directory);
      const now=new Date().toISOString();
      const binding:TelegramTopicBinding={chatId,threadId,sessionId:ready.session.id,directory,title,createdAt:now,updatedAt:now};
      await saveTelegramTopicBinding(binding);
      return {binding,session:ready.session};
    }catch(error){
      try {await topicNodeLifecycle.retire(chatId,threadId);}catch{throw new Error("Topic provisioning failed; retained reservation requires reconciliation",{cause:error});}
      await api.deleteForumTopic(chatId,threadId).catch(()=>undefined);
      throw error;
    }
  }).finally(()=>{if(chatCreations.get(chatId)===operation)chatCreations.delete(chatId);});
  chatCreations.set(chatId,operation);return operation;
}
