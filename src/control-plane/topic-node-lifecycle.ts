import {deleteForumTopicWithRetry} from "../app/services/telegram-forum-delete.js";
import {randomUUID} from "node:crypto";
import {logger} from "../utils/logger.js";
import type { Api } from "grammy";
import type { Session } from "@opencode-ai/sdk/v2";
import { nodeBindings, NodeBindingStore, type NodeBinding } from "./node-bindings.js";
import { readGlobalSnapshot } from "./global-state.js";
import {WorkerProvisioningError,type ProvisionedNode} from "../infrastructure/worker-provisioning-driver.js";
import { requestInfrastructure, requestNodeLifecycle } from "./application-transport.js";
import { saveTelegramTopicBinding, removeTelegramTopicBinding, listTelegramTopicBindings, type TelegramTopicBinding } from "../app/services/telegram-topic-store.js";
import { getNextManagedChatTitle } from "../app/services/telegram-topic-session-service.js";

let creationEnabled = false;
/** Explicit rollout gate. Existing local Topics are not migrated by enabling creation. */
export function setTopicNodeCreationEnabled(enabled: boolean): void { creationEnabled = enabled; }
export function isTopicNodeCreationEnabled(): boolean { return creationEnabled; }
interface LifecycleDependencies {
  bindings: NodeBindingStore;
  infrastructure(operation:"provision"|"rebind"|"recycle"|"retire"|"reconcile"|"inspect",nodeId:string,generation:number):Promise<ProvisionedNode>;
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
  bootstrapPool(warmCapacity?:number,repairOnly=false):Promise<NodeBinding[]> {
    if(this.poolFlight)return this.poolFlight;
    const operation=this.preparePool(warmCapacity,repairOnly).finally(()=>{if(this.poolFlight===operation)this.poolFlight=undefined;});
    this.poolFlight=operation;return operation;
  }
  private async waitReady(binding:NodeBinding,status:'provisioning'|'pool-provisioning'|'available'|'retiring',expected?:ProvisionedNode,allowRuntimeTransition=false):Promise<void> {
    const deadline=this.dependencies.now()+300_000;
    let delay=50;
    const expectedReadiness=binding.chatId===0&&binding.threadId===0?'ready-unbound':'ready';
    while(true) {
      let health:{ready:boolean;readiness?:string;runtime?:{telegramCoreCommit:string;telegramCoreVersion:string}}|undefined;
      try {health=await this.rpc(binding,'health');} catch { /* deployment/wake may still be underway */ }
      const explicitlyReady=health?.ready===true&&health?.readiness===expectedReadiness;
      if(health&&explicitlyReady){
        const runtimeMatches=!expected?.image||(health.runtime?.telegramCoreCommit===expected.runtimeCommit&&health.runtime?.telegramCoreVersion===expected.runtimeVersion);
        if(runtimeMatches){
          if(health.runtime)logger.info(`[WorkerImage] node=${binding.nodeId} generation=${binding.generation} image=${expected?.image??"legacy-contract"} actualCommit=${health.runtime.telegramCoreCommit} actualVersion=${health.runtime.telegramCoreVersion}`);
          break;
        }
        // Railway's old replica can still answer health while an immutable image
        // deployment is rolling out. Only an explicitly reported image transition
        // gets a bounded chance to converge; all other mismatches fail closed.
        if(!allowRuntimeTransition)throw new WorkerProvisioningError("image_mismatch");
      }
      if(this.dependencies.now()>=deadline)throw new Error("Topic node readiness timed out");
      await this.dependencies.wait(Math.min(delay,Math.max(0,deadline-this.dependencies.now())));delay=Math.min(delay*2,1_000);
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
  private async preparePool(warmCapacity?:number,repairOnly=false):Promise<NodeBinding[]> {
    const slots=await this.dependencies.bindings.ensurePoolSlots(warmCapacity??0);
    for(let binding of slots) {
      // A claimed Topic owns its Worker. Release reconciliation never enters that path.
      if(binding.chatId!==0||binding.threadId!==0)continue;
      // Recovery is deliberately limited to already-existing complete resources.
      if(repairOnly&&['pool-reserved','pool-provisioning'].includes(binding.status)&&(!binding.serviceId||!binding.volumeId||!binding.endpoint))continue;
      if(warmCapacity!==undefined&&binding.slot!>warmCapacity&&['pool-reserved','pool-provisioning','retiring'].includes(binding.status)){
        if(binding.status!=='retiring')binding=await this.dependencies.bindings.fence(binding.nodeId,binding.generation);
        const retired=await this.dependencies.infrastructure('retire',binding.nodeId,binding.generation);
        if(retired.nodeId!==binding.nodeId||retired.phase!=='retired')throw new Error("Warm Worker retirement not confirmed");
        await this.dependencies.bindings.update(binding.nodeId,binding.generation,{status:'retired'});continue;
      }
      if(binding.status==='retiring')continue;
      if(binding.status==='available'){
        // Compare-and-set the slot out of allocation before touching its image.
        const claimed=await this.dependencies.bindings.beginAvailableReconciliation(binding.nodeId,binding.generation);
        if(!claimed)continue;
        binding=claimed;
        try{
          const reconciled=await this.dependencies.infrastructure('reconcile',binding.nodeId,binding.generation);
          await this.waitReady(binding,'pool-provisioning',reconciled,reconciled.imageUpdated===true);
          const observed=await this.dependencies.infrastructure('inspect',binding.nodeId,binding.generation);
          if(observed.nodeId!==binding.nodeId||observed.generation!==binding.generation||!observed.serviceId||!observed.volumeId||!observed.endpoint||observed.serviceId!==binding.serviceId||observed.volumeId!==binding.volumeId||observed.projectId!==binding.projectId||observed.endpoint!==binding.endpoint)throw new WorkerProvisioningError("reconciliation_required");
          await this.waitReady(binding,'pool-provisioning',observed);
          binding=await this.syncGlobal(binding);
          // An image-changing reconcile returns before the canary; verify the new
          // runtime boundary while still fenced, then expose the slot as available.
          if(reconciled.imageUpdated)await this.dependencies.infrastructure('reconcile',binding.nodeId,binding.generation);
          binding=await this.dependencies.bindings.update(binding.nodeId,binding.generation,{status:'available'});
          logger.info("[WorkerCluster] idle Worker reconciled and verified: node="+binding.nodeId+" generation="+binding.generation);
        }catch(error){
          logger.warn("[WorkerCluster] idle Worker reconciliation failed; slot remains fenced: node="+binding.nodeId+" generation="+binding.generation,error);
          if(!repairOnly)throw error;
        }
        continue;
      }
      if(!['pool-reserved','pool-provisioning'].includes(binding.status))throw new Error("Invalid unbound Worker bootstrap state");
      const generation=binding.generation;
      if(binding.status!=='pool-provisioning')binding=await this.dependencies.bindings.update(binding.nodeId,generation,{status:'pool-provisioning'});
      try {
        // Existing provisioned slots must go through reconcile so stale immutable
        // image metadata is detected and the rollout is explicitly reported.
        const hasResources=Boolean(binding.serviceId&&binding.volumeId&&binding.endpoint);
        const reconciled=hasResources
          ? await this.dependencies.infrastructure('reconcile',binding.nodeId,generation)
          : await this.dependencies.infrastructure('provision',binding.nodeId,generation);
        if(reconciled.nodeId!==binding.nodeId||reconciled.generation!==generation||!reconciled.endpoint||!reconciled.serviceId||!reconciled.volumeId)throw new Error("Incomplete provisioned node identity");
        if(hasResources&&(reconciled.serviceId!==binding.serviceId||reconciled.volumeId!==binding.volumeId||reconciled.projectId!==binding.projectId||reconciled.endpoint!==binding.endpoint))throw new Error("Reconciled Worker resource identity mismatch");
        binding=await this.dependencies.bindings.update(binding.nodeId,generation,{projectId:reconciled.projectId,serviceId:reconciled.serviceId,volumeId:reconciled.volumeId,endpoint:reconciled.endpoint});
        await this.waitReady(binding,'pool-provisioning',reconciled,reconciled.imageUpdated===true);
        binding=await this.syncGlobal(binding);
        const observed=await this.dependencies.infrastructure('inspect',binding.nodeId,generation);
        if(observed.nodeId!==binding.nodeId||observed.generation!==generation||observed.projectId!==binding.projectId||observed.serviceId!==binding.serviceId||observed.volumeId!==binding.volumeId||observed.endpoint!==binding.endpoint)throw new WorkerProvisioningError("reconciliation_required");
        await this.waitReady(binding,'pool-provisioning',observed);
        // New provisioning and an image-changing reconcile both return before the
        // root-only replay/foreign-topic/stale-generation canary can be complete.
        if(!hasResources||reconciled.imageUpdated)await this.dependencies.infrastructure('reconcile',binding.nodeId,generation);
        binding=await this.dependencies.bindings.update(binding.nodeId,generation,{status:'available'});
      }catch(error){
        logger.warn("[WorkerCluster] Worker bootstrap failed; slot remains fenced: node="+binding.nodeId+" generation="+generation,error);
        if(!repairOnly)throw error;
      }
    }
    return (await this.dependencies.bindings.list()).filter(binding=>binding.status!=='retired').sort((a,b)=>a.slot!-b.slot!);
  }
  async verifyAvailableWorker():Promise<NodeBinding>{
    let available=(await this.dependencies.bindings.list()).filter(item=>item.status==='available'&&item.chatId===0&&item.threadId===0);
    if(!available.length){
      // A failed overflow allocation must not hide already-existing Workers.
      try{await this.bootstrapPool(undefined,true);}catch{ /* Continue with any other healthy unbound slot. */ }
      available=(await this.dependencies.bindings.list()).filter(item=>item.status==='available'&&item.chatId===0&&item.threadId===0);
    }
    let lastError:unknown;
    for(const candidate of available){
      const claimed=await this.dependencies.bindings.beginAvailableReconciliation(candidate.nodeId,candidate.generation);
      if(!claimed)continue;
      const binding=claimed;
      try{
        const reconciled=await this.dependencies.infrastructure('reconcile',binding.nodeId,binding.generation);
        await this.waitReady(binding,'pool-provisioning',reconciled,reconciled.imageUpdated===true);
        const observed=await this.dependencies.infrastructure('inspect',binding.nodeId,binding.generation);
        if(observed.nodeId!==binding.nodeId||observed.generation!==binding.generation||!observed.serviceId||!observed.volumeId||!observed.endpoint||observed.serviceId!==binding.serviceId||observed.volumeId!==binding.volumeId||observed.projectId!==binding.projectId||observed.endpoint!==binding.endpoint)throw new WorkerProvisioningError("reconciliation_required");
        await this.waitReady(binding,'pool-provisioning',observed);
        const synced=await this.syncGlobal(binding);
        if(reconciled.imageUpdated)await this.dependencies.infrastructure('reconcile',synced.nodeId,synced.generation);
        const ready=await this.dependencies.bindings.update(synced.nodeId,synced.generation,{status:'available'});
        return ready;
      }catch(error){
        lastError=error;
        logger.warn("[WorkerCluster] New Chat candidate failed runtime reconciliation; slot remains fenced: node="+binding.nodeId+" generation="+binding.generation,error);
      }
    }
    if(lastError)throw lastError;
    throw new WorkerProvisioningError("capacity_exhausted");
  }
  ensureReady(chatId:number,threadId:number,directory:string,prepared?:NodeBinding):Promise<{binding:NodeBinding;session:Session}> {
    const key=`${chatId}:${threadId}`;const existing=this.flights.get(key);if(existing)return existing;
    const operation=this.prepare(chatId,threadId,directory,prepared).finally(()=>{if(this.flights.get(key)===operation)this.flights.delete(key);});
    this.flights.set(key,operation);return operation;
  }
  private async prepare(chatId:number,threadId:number,directory:string,prepared?:NodeBinding):Promise<{binding:NodeBinding;session:Session}> {
    let binding=prepared?await this.dependencies.bindings.reservePrepared(chatId,threadId,prepared):await this.dependencies.bindings.reserve(chatId,threadId);
    if(binding.status==='retiring')throw new Error("Topic node is being retired");
    const generation=binding.generation;
    const inPlaceRebind=binding.status==='reserved'&&!!binding.slot&&!!binding.serviceId&&!!binding.volumeId&&!!binding.endpoint&&generation>1;
    try {
      if(binding.status!=='ready') {
        binding=await this.dependencies.bindings.update(binding.nodeId,generation,{status:'provisioning'});
        const provisioned=await this.dependencies.infrastructure(inPlaceRebind?'rebind':'provision',binding.nodeId,generation);
        if(provisioned.nodeId!==binding.nodeId||provisioned.generation!==generation||!provisioned.endpoint||!provisioned.serviceId||!provisioned.volumeId)throw new Error("Incomplete provisioned node identity");
        if(inPlaceRebind&&(provisioned.serviceId!==binding.serviceId||provisioned.volumeId!==binding.volumeId||provisioned.projectId!==binding.projectId||provisioned.endpoint!==binding.endpoint))throw new Error('Rebound Worker resource identity mismatch');
        binding=await this.dependencies.bindings.update(binding.nodeId,generation,{projectId:provisioned.projectId,serviceId:provisioned.serviceId,volumeId:provisioned.volumeId,endpoint:provisioned.endpoint});
        await this.waitReady(binding,'provisioning',provisioned);
      }
      binding=await this.syncGlobal(binding);
      if(!binding.sessionId){
        const created=await this.rpc<{sessionId:string}>(binding,'session.create');
        if(!created.sessionId||typeof created.sessionId!=='string')throw new Error("Node returned invalid session");
        binding=await this.dependencies.bindings.update(binding.nodeId,generation,{sessionId:created.sessionId});
      }
      const session=await this.rpc<Session>(binding,'session.get');
      if(session.id!==binding.sessionId||typeof session.title!=='string')throw new Error("Node session identity mismatch");
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
    const current=await this.dependencies.bindings.find(chatId,threadId);
    if(!current)return false;
    let binding=await this.dependencies.bindings.beginRecycle(current.nodeId,current.generation);
    try{
      const recycled=await this.dependencies.infrastructure('recycle',binding.nodeId,binding.generation);
      if(recycled.nodeId!==binding.nodeId||recycled.phase!=='recycled'||recycled.serviceId!==binding.serviceId||recycled.volumeId!==binding.volumeId)throw new Error("Infrastructure recycle not confirmed");
      await this.waitReady(binding,'retiring',recycled);
      binding=await this.syncGlobal(binding);
      binding=await this.dependencies.bindings.completeRecycle(binding.nodeId,binding.generation);
      await this.dependencies.infrastructure('reconcile',binding.nodeId,binding.generation);
      return true;
    }catch(error){
      logger.warn(`[WorkerCluster] in-place recycle failed; Worker remains fenced node=${binding.nodeId} generation=${binding.generation}`,error);
      throw error;
    }
  }
}
export const topicNodeLifecycle=new TopicNodeLifecycle();
const chatCreations=new Map<number,Promise<unknown>>();
type RemoteTopicCreation={binding:TelegramTopicBinding;reused:true}|{binding:TelegramTopicBinding;session:Session;reused:false};
const creationFlights=new Map<string,Promise<RemoteTopicCreation>>();
export function createRemoteTopicSession(api:Api,chatId:number,directory:string,requestKey:string=randomUUID()):Promise<RemoteTopicCreation> {
  const key=`${chatId}:${requestKey}`;const flight=creationFlights.get(key);if(flight)return flight;
  const previous=chatCreations.get(chatId)??Promise.resolve();
  const operation=previous.catch(()=>undefined).then(async()=>{
    const receipt=await nodeBindings.beginCreation(requestKey,chatId,directory);
    if(receipt.operation.failed||!receipt.fresh&&!receipt.operation.threadId)throw new WorkerProvisioningError("reconciliation_required");
    directory=receipt.operation.directory;
    const cleanup=async(threadId:number)=>{
      // Persist the irreversible cleanup phase before fencing or external deletion.
      // An interrupted retry may only finish cleanup, never allocate another Worker.
      await nodeBindings.recordCreation(requestKey,chatId,{cleaning:true});
      await topicNodeLifecycle.retire(chatId,threadId);
      await deleteForumTopicWithRetry(api,chatId,threadId);
      const saved=(await listTelegramTopicBindings()).find(b=>b.chatId===chatId&&b.threadId===threadId);
      if(saved)await removeTelegramTopicBinding(chatId,saved.sessionId);
      await nodeBindings.recordCreation(requestKey,chatId,{failed:true});
    };
    if(receipt.operation.cleaning){
      if(receipt.operation.threadId)await cleanup(receipt.operation.threadId);
      throw new WorkerProvisioningError("reconciliation_required");
    }
    const title=getNextManagedChatTitle(await listTelegramTopicBindings(),chatId);
    let threadId=receipt.operation.threadId;
    let prepared:NodeBinding|undefined;
    if(!threadId){
      try{
        prepared=await topicNodeLifecycle.verifyAvailableWorker();
        await nodeBindings.recordCreation(requestKey,chatId,{nodeId:prepared.nodeId,generation:prepared.generation});
        const topic=await api.raw.createForumTopic({chat_id:chatId,name:title});
        if(!topic.message_thread_id)throw new Error("Telegram Topic identity missing");
        threadId=topic.message_thread_id;
        await nodeBindings.recordCreation(requestKey,chatId,{threadId});
      }catch(error){
        if(threadId)await cleanup(threadId);
        else await nodeBindings.recordCreation(requestKey,chatId,{failed:true});
        throw error;
      }
    }
    const existing=(await listTelegramTopicBindings()).find(b=>b.chatId===chatId&&b.threadId===threadId);
    if(!receipt.fresh&&existing){
      const canonical=await nodeBindings.find(chatId,threadId);
      if(!canonical||canonical.status!=='ready'||canonical.sessionId!==existing.sessionId||receipt.operation.completed&&(canonical.nodeId!==receipt.operation.nodeId||canonical.generation!==receipt.operation.generation))throw new WorkerProvisioningError("reconciliation_required");
      // A completed receipt is a read-only acknowledgement. Never reserve or
      // execute here: deletion may fence this generation immediately after lookup.
      return {binding:existing,reused:true as const};
    }
    if(receipt.operation.completed&&!existing)throw new WorkerProvisioningError("reconciliation_required");
    try {
      prepared??=(await nodeBindings.list()).find(item=>item.nodeId===receipt.operation.nodeId&&[receipt.operation.generation,Number(receipt.operation.generation)+1].includes(item.generation));
      if(!prepared)throw new WorkerProvisioningError('reconciliation_required');
      const ready=await topicNodeLifecycle.ensureReady(chatId,threadId,directory,prepared);
      const now=new Date().toISOString();
      const binding:TelegramTopicBinding={chatId,threadId,sessionId:ready.session.id,directory,title,createdAt:now,updatedAt:now};
      await saveTelegramTopicBinding(binding);
      await nodeBindings.recordCreation(requestKey,chatId,{completed:true,nodeId:ready.binding.nodeId,generation:ready.binding.generation});
      return {binding,session:ready.session,reused:false as const};
    }catch(error){
      try {await cleanup(threadId);}catch{throw new WorkerProvisioningError("reconciliation_required");}
      throw error;
    }
  }).finally(()=>{if(chatCreations.get(chatId)===operation)chatCreations.delete(chatId);if(creationFlights.get(key)===operation)creationFlights.delete(key);});
  chatCreations.set(chatId,operation);creationFlights.set(key,operation);return operation;
}
