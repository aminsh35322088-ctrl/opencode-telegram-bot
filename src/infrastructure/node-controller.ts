import {randomBytes,randomUUID} from 'node:crypto';
import {WORKER_CORE_COMMIT,WORKER_CORE_VERSION,WORKER_RUNTIME_IMAGE} from './worker-core-release.js';
import {lstat,mkdir,open,readFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {syncDirectory} from '../utils/sync-directory.js';
import {isOwnUser,isRestrictiveMode} from '../utils/file-ownership.js';
import type {NodeBinding} from '../control-plane/node-bindings.js';
import {RailwayProvisioningDriver} from './railway-provisioning-driver.js';
import type {WorkerProvisioningDriver,ProvisionedNode,WorkerPool} from './worker-provisioning-driver.js';
import type {captureNodeRegistry} from './node-registry.js';
import type {InfrastructureNodeIdentity} from './node-registry.js';

interface Options {
 registry:ReturnType<typeof captureNodeRegistry>;
 stateDirectory:string;bindingFilename:string;
 request<T>(document:string,variables:Record<string,unknown>):Promise<T>;
 pools?:WorkerPool[];controlUrl?:string;coreCommit?:string;workerImage?:string;
 retireNode?(identity:Readonly<InfrastructureNodeIdentity>,sanitize?:boolean):Promise<void>;
 issueBootstrap?(binding:Readonly<NodeBinding>,endpoint:string,secret:string):Promise<string>;
 rotateNode?(identity:Readonly<InfrastructureNodeIdentity>,bootstrapToken:string,target:Readonly<NodeBinding>):Promise<void>;
 probeUnbound?(nodeId:string,generation:number):Promise<unknown>;
 onClusterVerified?():Promise<void>;
}
interface Seed {nodeId:string;generation:number;chatId:number;threadId:number;secret:string}
/** Only inherited Bot IPC can invoke these fixed lifecycle operations. No Worker route provisions infrastructure. */
export class InfrastructureController {
 private provisioner?:WorkerProvisioningDriver;
 private poolConfiguration?:Promise<void>;
 private queue:Promise<unknown>=Promise.resolve();
 private verifiedUnbound=new Map<string,number>();
 private clusterVerified=false;
 constructor(private readonly options:Options){
  if(options.pools && options.controlUrl)this.configurePools(options.pools,options.controlUrl);
 }
 /** One startup inventory operation gates requests; it never retries mutations. */
 setPoolCapacity(capacity:number):void{ this.provisioner?.setPoolCapacity(capacity); }
 waitForPoolConfiguration(operation:Promise<void>):void{
  if(this.poolConfiguration||this.provisioner)throw Error('Worker pool configuration already started');
  this.poolConfiguration=operation;void operation.catch(()=>undefined);
 }
 configurePools(pools:WorkerPool[],controlUrl:string,createPool?:(excluded:ReadonlySet<string>)=>Promise<WorkerPool>):void{
  if(this.provisioner)throw Error('Worker pools already configured');
  const options=this.options;
  this.provisioner=new RailwayProvisioningDriver({request:options.request,pools,controlUrl,createPool,coreCommit:options.coreCommit,workerImage:options.workerImage,journalPath:path.join(options.stateDirectory,'provisioning.json'),onStage:stage=>{process.stdout.write(`[InfrastructureBoundary] worker_provision_stage=${stage}\n`);},onInventory:inventory=>{
   const volumes=inventory.project.volumes.edges.map(entry=>({volumeId:entry.node.id,instances:entry.node.volumeInstances.edges.map(item=>({environmentId:item.node.environmentId,serviceId:item.node.serviceId,sizeMB:item.node.sizeMB,mountPath:item.node.mountPath,pendingDeletion:item.node.isPendingDeletion}))}));
   process.stdout.write(`[InfrastructureBoundary] worker_volume_inventory project=${inventory.project.id} volumes=${JSON.stringify(volumes)}\n`);
  },lookup:id=>this.lookup(id),ensureIdentity:(binding,create)=>this.ensureIdentity(binding,create),retireIdentity:async(id,generation)=>{
   // Explicit Delete may terminate an offline/crashed owned container through
   // resource deletion after durable fencing. Reusing its volume for a handoff
   // below instead requires a signed successful Core retirement before rotation.
   const identity=await options.registry.resolve(id);if(identity){options.registry.install({...identity,binding:{...identity.binding,generation,status:'retired'}});await options.registry.persist(path.join(options.stateDirectory,'nodes.json'));await options.retireNode?.(identity).catch(()=>undefined);}
  },configured:async(binding,node)=>{
   const seed=await this.ensureIdentity(binding,()=>{throw Error('Missing provisioned identity');});
   if(!node.endpoint)throw Error('Worker endpoint missing');
   options.registry.install({binding:{nodeId:binding.nodeId,generation:binding.generation,chatId:binding.chatId,threadId:binding.threadId,status:'provisioning',sessionId:binding.sessionId},endpoint:node.endpoint,secret:seed});
   await options.registry.persist(path.join(options.stateDirectory,'nodes.json'));
  }});
 }
 async discardDeletedProjects(projectIds:readonly string[]):Promise<Array<{nodeId:string;generation:number}>>{
  if(!this.provisioner)throw Error('Worker pools not configured');
  const retired=await this.provisioner.discardDeletedProjects(projectIds);
  for(const record of retired){
   const identity=await this.options.registry.resolve(record.nodeId);
   if(identity)this.options.registry.install({...identity,binding:{...identity.binding,status:'retired'}});
   this.verifiedUnbound.delete(record.nodeId);
  }
  if(retired.length)await this.options.registry.persist(path.join(this.options.stateDirectory,'nodes.json'));
  process.stdout.write(`[InfrastructureBoundary] deleted_pools_reconciled projects=${projectIds.length} workers=${retired.length}\n`);
  return retired.map(({nodeId,generation})=>({nodeId,generation}));
 }
 async bootstrapInventory():Promise<{projectCount:number;workers:Array<ProvisionedNode & {verified:boolean}>}>{
  if(!this.provisioner)throw Error('Worker pools not configured');
  const inventory=await this.provisioner.bootstrapInventory();
  const workers=await Promise.all(inventory.workers.map(async worker=>{
   const identity=await this.options.registry.resolve(worker.nodeId);
   const canonical=await this.lookup(worker.nodeId);
   const canonicalAvailable=canonical?.nodeId===worker.nodeId&&canonical.generation===worker.generation&&canonical.status==='available'&&canonical.chatId===0&&canonical.threadId===0&&canonical.projectId===worker.projectId&&canonical.serviceId===worker.serviceId&&canonical.volumeId===worker.volumeId&&canonical.endpoint===worker.endpoint;
   return {...worker,verified:this.verifiedUnbound.get(worker.nodeId)===worker.generation&&identity?.binding.generation===worker.generation&&identity.binding.status==='available'&&canonicalAvailable};
  }));
  return {...inventory,workers};
 }
 private async lookup(id:string):Promise<NodeBinding|undefined>{
  // Fixed canonical path, bounded regular file. Never take a filesystem path from IPC.
  try{const stat=await lstat(this.options.bindingFilename);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)throw Error('Invalid canonical bindings');
   const state=JSON.parse(await readFile(this.options.bindingFilename,'utf8')) as {version:number;bindings:NodeBinding[]};
   if(state.version!==1||!Array.isArray(state.bindings)||state.bindings.length>1000)throw Error('Invalid canonical bindings');
   const active=state.bindings.filter(b=>b.status!=='retired');if(new Set(active.filter(b=>b.threadId>1).map(b=>`${b.chatId}:${b.threadId}`)).size!==active.filter(b=>b.threadId>1).length)throw Error('Invalid canonical capacity');
   const matches=state.bindings.filter(b=>b.nodeId===id);if(matches.length>1)throw Error('Invalid canonical identity');return matches[0];
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
 }
 private async ensureIdentity(binding:Readonly<NodeBinding>,create:()=>string):Promise<string>{
  const filename=path.join(this.options.stateDirectory,'identity-seeds.json');let seeds:Seed[]=[];
  try{const stat=await lstat(filename);if(!stat.isFile()||stat.isSymbolicLink()||!isRestrictiveMode(stat.mode)||!isOwnUser(stat.uid)||stat.size>1024*1024)throw Error('Invalid identity seed store');seeds=JSON.parse(await readFile(filename,'utf8')) as Seed[];if(!Array.isArray(seeds)||seeds.length>1000)throw Error('Invalid identity seed store');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const existing=seeds.find(seed=>seed.nodeId===binding.nodeId);
  if(existing){
   if(existing.generation===binding.generation&&existing.chatId===binding.chatId&&existing.threadId===binding.threadId)return existing.secret;
   if(existing.chatId!==0||existing.threadId!==0||binding.threadId<=1||binding.chatId===0||binding.generation!==existing.generation+1)throw Error('Identity seed scope mismatch');
   const previous=await this.options.registry.resolve(binding.nodeId);
   if(!previous||previous.binding.chatId!==0||previous.binding.threadId!==0||
      !(previous.binding.generation===existing.generation||(previous.binding.generation===binding.generation&&previous.binding.status==='retired'))||!this.options.retireNode)throw Error('Unbound handoff identity missing');
   // Durable Control fence precedes old Core retirement and any new env/secret.
   this.options.registry.install({...previous,binding:{...previous.binding,generation:binding.generation,status:'retired'}});
   await this.options.registry.persist(path.join(this.options.stateDirectory,'nodes.json'));
   await this.options.retireNode({...previous,secret:existing.secret,binding:{...previous.binding,nodeId:existing.nodeId,generation:existing.generation,chatId:0,threadId:0}});
   const replacement=create();if(!/^[a-zA-Z0-9_-]{64,}$/.test(replacement)||replacement===existing.secret)throw Error('Invalid rotated identity seed');
   Object.assign(existing,{generation:binding.generation,chatId:binding.chatId,threadId:binding.threadId,secret:replacement});
  }
  const secret=existing?.secret??create();if(!/^[a-zA-Z0-9_-]{64,}$/.test(secret))throw Error('Invalid identity seed');
  if(!existing)seeds.push({nodeId:binding.nodeId,generation:binding.generation,chatId:binding.chatId,threadId:binding.threadId,secret});
  await mkdir(this.options.stateDirectory,{recursive:true,mode:0o700});const temporary=`${filename}.${randomUUID()}.tmp`;const file=await open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify(seeds));await file.sync();}finally{await file.close();}await rename(temporary,filename);await syncDirectory(this.options.stateDirectory);return secret;
 }
 private async rotateIdentitySeed(binding:Readonly<NodeBinding>,previous:Readonly<InfrastructureNodeIdentity>):Promise<string>{
  const filename=path.join(this.options.stateDirectory,'identity-seeds.json');let seeds:Seed[]=[];
  try{const stat=await lstat(filename);if(!stat.isFile()||stat.isSymbolicLink()||!isRestrictiveMode(stat.mode)||!isOwnUser(stat.uid)||stat.size>1024*1024)throw Error('Invalid identity seed store');seeds=JSON.parse(await readFile(filename,'utf8')) as Seed[];if(!Array.isArray(seeds)||seeds.length>1000)throw Error('Invalid identity seed store');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const seed=seeds.find(item=>item.nodeId===binding.nodeId);if(!seed)throw Error('Identity seed missing for in-place rotation');
  if(seed.generation===binding.generation&&seed.chatId===binding.chatId&&seed.threadId===binding.threadId)return seed.secret;
  if(seed.generation!==previous.binding.generation||seed.chatId!==previous.binding.chatId||seed.threadId!==previous.binding.threadId||binding.generation!==previous.binding.generation+1)throw Error('Identity rotation fence mismatch');
  const oldUnbound=previous.binding.chatId===0&&previous.binding.threadId===0;const nextUnbound=binding.chatId===0&&binding.threadId===0;if(oldUnbound===nextUnbound)throw Error('Identity rotation must alternate bound ownership');
  const replacement=randomBytes(48).toString('base64url');if(replacement===seed.secret||replacement===previous.secret)throw Error('Invalid rotated identity seed');
  Object.assign(seed,{generation:binding.generation,chatId:binding.chatId,threadId:binding.threadId,secret:replacement});
  await mkdir(this.options.stateDirectory,{recursive:true,mode:0o700});const temporary=`${filename}.${randomUUID()}.tmp`;const file=await open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify(seeds));await file.sync();}finally{await file.close();}await rename(temporary,filename);await syncDirectory(this.options.stateDirectory);return replacement;
 }
 /** Root startup maintenance only; never exposed through request() or inherited application IPC. */
 cleanupRuntimeCanaryVariables(nodeId:string,generation:number,selftest:(nodeId:string,generation:number,profile:"baseline"|"browser"|"network")=>Promise<unknown>,alreadySerialized=false):Promise<void>{
  const run=async()=>{
   try{
    if(this.poolConfiguration)await this.poolConfiguration;
    if(!this.provisioner||typeof nodeId!=="string"||nodeId.length>128||!Number.isSafeInteger(generation)||generation<1)throw Error("Worker cleanup unavailable");
    const before=await this.lookup(nodeId);
    const available=(binding:NodeBinding|undefined)=>binding?.nodeId===nodeId&&binding.generation===generation&&binding.slot===1&&binding.chatId===0&&binding.threadId===0&&["available","pool-provisioning"].includes(binding.status)&&binding.sessionId===undefined&&!!binding.projectId&&!!binding.serviceId&&!!binding.volumeId;
    if(!available(before))throw Error("Worker cleanup fence changed");
    await this.provisioner.cleanupDeprecatedWorkerVariables(nodeId,generation,selftest);
    const after=await this.lookup(nodeId);
    if(!available(after)||after!.projectId!==before!.projectId||after!.serviceId!==before!.serviceId||after!.volumeId!==before!.volumeId||after!.clusterId!==before!.clusterId||after!.endpoint!==before!.endpoint)throw Error("Worker cleanup fence changed");
   }catch{throw Error("Worker runtime canary cleanup failed");}
  };
  if(alreadySerialized)return run();
  const task=this.queue.then(run);this.queue=task.catch(()=>undefined);return task;
 }
 request(operation:string,nodeId:string,generation:number):Promise<ProvisionedNode>{
  const task=this.queue.then(async()=>{
   if(!['provision','rebind','recycle','retire','reconcile','inspect'].includes(operation)||typeof nodeId!=='string'||nodeId.length>128||!Number.isSafeInteger(generation)||generation<1)throw Error('Infrastructure operation denied');
   const binding=await this.lookup(nodeId);if(!binding||binding.generation!==generation)throw Error('Infrastructure binding denied');
   if(operation==='inspect'){if(this.poolConfiguration)await this.poolConfiguration;if(!this.provisioner)throw Error('Worker pools not configured');return this.provisioner.inspectWorker(nodeId,generation);}
   if(operation==='provision'){if(this.poolConfiguration)await this.poolConfiguration;if(!this.provisioner)throw Error('Worker pools not configured');return this.provisioner.provision(nodeId,generation);}
   if(operation==='rebind'||operation==='recycle'){
    if(this.poolConfiguration)await this.poolConfiguration;if(!this.provisioner||!this.options.retireNode||!this.options.issueBootstrap||!this.options.rotateNode)throw Error('Worker in-place rotation unavailable');
    const targetUnbound=binding.chatId===0&&binding.threadId===0;
    if((operation==='rebind'&&(targetUnbound||binding.status!=='provisioning'))||(operation==='recycle'&&(!targetUnbound||binding.status!=='retiring'))||!binding.serviceId||!binding.volumeId||!binding.endpoint||!binding.slot)throw Error('Worker in-place rotation scope denied');
    const registered=await this.options.registry.resolve(nodeId);if(!registered)throw Error('Worker in-place identity unavailable');
    if(registered.binding.generation===generation&&registered.binding.chatId===binding.chatId&&registered.binding.threadId===binding.threadId){return this.provisioner.handoff(nodeId,generation);}
    if(registered.binding.generation!==generation-1||registered.binding.nodeId!==nodeId||registered.endpoint!==binding.endpoint)throw Error('Worker in-place generation fence mismatch');
    const oldUnbound=registered.binding.chatId===0&&registered.binding.threadId===0;if(oldUnbound===targetUnbound)throw Error('Worker in-place ownership transition denied');
    this.options.registry.install({...registered,binding:{...registered.binding,status:'retiring'}});await this.options.registry.persist(path.join(this.options.stateDirectory,'nodes.json'));
    await this.options.retireNode(registered,true);
    const secret=await this.rotateIdentitySeed(binding,registered);const token=await this.options.issueBootstrap(binding,registered.endpoint,secret);await this.options.rotateNode(registered,token,binding);
    const rotated=await this.options.registry.resolve(nodeId);if(!rotated||rotated.binding.generation!==generation||rotated.binding.chatId!==binding.chatId||rotated.binding.threadId!==binding.threadId||rotated.endpoint!==binding.endpoint||rotated.secret!==secret)throw Error('Worker in-place rotation not proven');
    return this.provisioner.handoff(nodeId,generation);
   }
   if(operation==='retire'){if(!this.provisioner)throw Error('Worker pools not configured');return this.provisioner.retire(nodeId,generation);}
   // Reconcile the configured immutable image only for an unbound, already
   // provisioned Worker. A Topic-bound generation never enters this path.
   if(operation==='reconcile'&&binding.chatId===0&&binding.threadId===0&&['available','pool-provisioning'].includes(binding.status)&&binding.projectId&&binding.serviceId&&binding.volumeId&&binding.endpoint&&binding.slot){
    if(this.poolConfiguration)await this.poolConfiguration;
    const provisioner=this.provisioner;if(!provisioner)throw Error('Worker pools not configured');
    const before=(await provisioner.listWorkers()).find(item=>item.nodeId===nodeId&&item.generation===generation);
    const desiredImage=this.options.workerImage??WORKER_RUNTIME_IMAGE;
    const desiredCommit=this.options.coreCommit??WORKER_CORE_COMMIT;
    const desiredVersion=WORKER_CORE_VERSION;
    const imageDrift=Boolean(before?.image&&desiredImage&&(before.image!==desiredImage||before.runtimeCommit!==desiredCommit||before.runtimeVersion!==desiredVersion));
    // "recycled" is the normal durable state of an idle Worker after a Topic is
    // retired. Inspect it without deployment churn when its immutable release is
    // already current; only image drift or an incomplete provisioning phase calls
    // provision(), which may apply a new source and initiate a Railway deployment.
    const needsProvision=!before||imageDrift||!["deploying","recycled"].includes(before.phase);
    const reconciled=needsProvision
      ? await provisioner.provision(nodeId,generation)
      : await provisioner.inspectWorker(nodeId,generation);
    const imageUpdateStarted=Boolean(reconciled.image&&(!before||before.image!==reconciled.image||before.runtimeCommit!==reconciled.runtimeCommit||before.runtimeVersion!==reconciled.runtimeVersion));
    const currentBinding=await this.lookup(nodeId);
    if(!currentBinding||currentBinding.generation!==generation||currentBinding.chatId!==0||currentBinding.threadId!==0||currentBinding.status!==binding.status||currentBinding.serviceId!==binding.serviceId||currentBinding.volumeId!==binding.volumeId||currentBinding.endpoint!==binding.endpoint)throw Error('Canonical Worker binding changed during runtime reconciliation');
    const registered=await this.options.registry.resolve(nodeId);
    if(!registered||registered.binding.generation!==generation||registered.binding.chatId!==0||registered.binding.threadId!==0||registered.endpoint!==binding.endpoint)throw Error('Worker registry changed during runtime reconciliation');
    this.options.registry.install({...registered,binding:{...registered.binding,status:binding.status}});
    await this.options.registry.persist(path.join(this.options.stateDirectory,'nodes.json'));
    if(imageUpdateStarted){
     this.verifiedUnbound.delete(nodeId);
     process.stdout.write(`[InfrastructureBoundary] worker_image_update_started node=${nodeId} generation=${generation} version=${reconciled.runtimeVersion??"unknown"}\n`);
     return {...reconciled,imageUpdated:true};
    }
   }
   const identity=await this.options.registry.resolve(nodeId);if(!identity||identity.binding.generation!==generation||identity.binding.chatId!==binding.chatId||identity.binding.threadId!==binding.threadId)throw Error('Infrastructure identity mismatch');
   if(binding.status==='ready' && (!binding.sessionId||binding.sessionId!==identity.binding.sessionId))throw Error('Infrastructure session mismatch');
   this.options.registry.install({...identity,binding:{...identity.binding,status:binding.status}});await this.options.registry.persist(path.join(this.options.stateDirectory,'nodes.json'));
   if(['available','pool-provisioning'].includes(binding.status)&&binding.chatId===0&&binding.threadId===0&&this.options.probeUnbound){
    if(this.verifiedUnbound.get(nodeId)!==generation){
     try{await this.options.probeUnbound(nodeId,generation);}catch(error){
      this.verifiedUnbound.delete(nodeId);
      this.options.registry.install({...identity,binding:{...identity.binding,status:'provisioning'}});
      await this.options.registry.persist(path.join(this.options.stateDirectory,'nodes.json'));
      throw error;
     }
     process.stdout.write("[InfrastructureBoundary] worker_boundary_verified node="+nodeId+" generation="+generation+" health=true replayRejected=true foreignTopicRejected=true staleGenerationRejected=true\n");
     this.verifiedUnbound.set(nodeId,generation);
    }
    // Keep a newly verified Worker fenced until the cluster-level runtime
    // canary and startup cleanup also pass. Lifecycle marks it available only
    // after this request returns successfully.
    if(!this.clusterVerified&&this.verifiedUnbound.size>0&&this.options.registry.metadata().filter(b=>b.chatId===0&&b.threadId===0&&b.status!=='retired').every(b=>this.verifiedUnbound.get(b.nodeId)===b.generation)){
     const current=await Promise.all([...this.verifiedUnbound].map(async([id,verifiedGeneration])=>{
      const canonical=await this.lookup(id);const registered=await this.options.registry.resolve(id);
      return canonical?.generation===verifiedGeneration&&["available","pool-provisioning"].includes(canonical.status)&&canonical.chatId===0&&canonical.threadId===0&&registered?.binding.generation===verifiedGeneration&&["available","pool-provisioning"].includes(registered.binding.status);
     }));
     if(current.every(Boolean)){await this.options.onClusterVerified?.();this.clusterVerified=true;}
    }
    // Root's authenticated identity may be marked available after its canaries
    // pass. Canonical Topic allocation remains fenced as pool-provisioning until
    // the calling lifecycle atomically commits the matching durable state.
    const canonical=await this.lookup(nodeId);
    const registered=await this.options.registry.resolve(nodeId);
    if(!canonical||canonical.generation!==generation||canonical.chatId!==0||canonical.threadId!==0||!['available','pool-provisioning'].includes(canonical.status)||!registered||registered.binding.generation!==generation||registered.binding.chatId!==0||registered.binding.threadId!==0)throw Error('Canonical Worker changed after boundary verification');
    if(canonical.status==='pool-provisioning'){
     this.options.registry.install({...registered,binding:{...registered.binding,status:'available'}});
     await this.options.registry.persist(path.join(this.options.stateDirectory,'nodes.json'));
    }
   }
   return {nodeId,generation,projectId:binding.projectId??'',environmentId:'',endpoint:identity.endpoint,serviceId:binding.serviceId,volumeId:binding.volumeId,phase:'deploying' as const};
  });this.queue=task.catch(()=>undefined);return task;
 }
}
