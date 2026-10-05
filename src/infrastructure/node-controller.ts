import {randomUUID} from 'node:crypto';
import {lstat,mkdir,open,readFile,rename} from 'node:fs/promises';
import path from 'node:path';
import type {NodeBinding} from '../control-plane/node-bindings.js';
import {NodeProvisioner,type ProvisionedNode,type WorkerPool} from './node-provisioner.js';
import type {captureNodeRegistry} from './node-registry.js';
import type {InfrastructureNodeIdentity} from './node-registry.js';

interface Options {
 registry:ReturnType<typeof captureNodeRegistry>;
 stateDirectory:string;bindingFilename:string;
 request<T>(document:string,variables:Record<string,unknown>):Promise<T>;
 pools?:[WorkerPool,WorkerPool];controlUrl?:string;
 retireNode?(identity:Readonly<InfrastructureNodeIdentity>):Promise<void>;
}
interface Seed {nodeId:string;generation:number;chatId:number;threadId:number;secret:string}
/** Only inherited Bot IPC can invoke these fixed lifecycle operations. No Worker route provisions infrastructure. */
export class InfrastructureController {
 private readonly provisioner?:NodeProvisioner;
 private queue:Promise<unknown>=Promise.resolve();
 constructor(private readonly options:Options){
  if(options.pools && options.controlUrl)this.provisioner=new NodeProvisioner({request:options.request,pools:options.pools,controlUrl:options.controlUrl,journalPath:path.join(options.stateDirectory,'provisioning.json'),lookup:id=>this.lookup(id),ensureIdentity:(binding,create)=>this.ensureIdentity(binding,create),retireIdentity:async(id,generation)=>{
   const identity=await options.registry.resolve(id);if(identity){options.registry.install({...identity,binding:{...identity.binding,generation,status:'retired'}});await options.registry.persist(path.join(options.stateDirectory,'nodes.json'));await options.retireNode?.(identity).catch(()=>undefined);}
  },configured:async(binding,node)=>{
   const seed=await this.ensureIdentity(binding,()=>{throw Error('Missing provisioned identity');});
   if(!node.endpoint)throw Error('Worker endpoint missing');
   options.registry.install({binding:{nodeId:binding.nodeId,generation:binding.generation,chatId:binding.chatId,threadId:binding.threadId,status:'provisioning',sessionId:binding.sessionId},endpoint:node.endpoint,secret:seed});
   await options.registry.persist(path.join(options.stateDirectory,'nodes.json'));
  }});
 }
 private async lookup(id:string):Promise<NodeBinding|undefined>{
  // Fixed canonical path, bounded regular file. Never take a filesystem path from IPC.
  try{const stat=await lstat(this.options.bindingFilename);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)throw Error('Invalid canonical bindings');
   const state=JSON.parse(await readFile(this.options.bindingFilename,'utf8')) as {version:number;bindings:NodeBinding[]};
   if(state.version!==1||!Array.isArray(state.bindings)||state.bindings.length>1000)throw Error('Invalid canonical bindings');
   const active=state.bindings.filter(b=>b.status!=='retired');if(active.length>4 || new Set(active.map(b=>`${b.chatId}:${b.threadId}`)).size!==active.length)throw Error('Invalid canonical capacity');
   const matches=state.bindings.filter(b=>b.nodeId===id);if(matches.length>1)throw Error('Invalid canonical identity');return matches[0];
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
 }
 private async ensureIdentity(binding:Readonly<NodeBinding>,create:()=>string):Promise<string>{
  const filename=path.join(this.options.stateDirectory,'identity-seeds.json');let seeds:Seed[]=[];
  try{const stat=await lstat(filename);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.()||stat.size>1024*1024)throw Error('Invalid identity seed store');seeds=JSON.parse(await readFile(filename,'utf8')) as Seed[];if(!Array.isArray(seeds)||seeds.length>1000)throw Error('Invalid identity seed store');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const existing=seeds.find(seed=>seed.nodeId===binding.nodeId);
  if(existing){if(existing.generation!==binding.generation||existing.chatId!==binding.chatId||existing.threadId!==binding.threadId)throw Error('Identity seed scope mismatch');return existing.secret;}
  const secret=create();if(!/^[a-zA-Z0-9_-]{64,}$/.test(secret))throw Error('Invalid identity seed');
  seeds.push({nodeId:binding.nodeId,generation:binding.generation,chatId:binding.chatId,threadId:binding.threadId,secret});
  await mkdir(this.options.stateDirectory,{recursive:true,mode:0o700});const temporary=`${filename}.${randomUUID()}.tmp`;const file=await open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify(seeds));await file.sync();}finally{await file.close();}await rename(temporary,filename);const dir=await open(this.options.stateDirectory,'r');try{await dir.sync();}finally{await dir.close();}return secret;
 }
 request(operation:string,nodeId:string,generation:number):Promise<ProvisionedNode>{
  const task=this.queue.then(async()=>{
   if(!['provision','retire','reconcile'].includes(operation)||typeof nodeId!=='string'||nodeId.length>128||!Number.isSafeInteger(generation)||generation<1)throw Error('Infrastructure operation denied');
   const binding=await this.lookup(nodeId);if(!binding||binding.generation!==generation)throw Error('Infrastructure binding denied');
   if(operation==='provision'){if(!this.provisioner)throw Error('Worker pools not configured');return this.provisioner.provision(nodeId,generation);}
   if(operation==='retire'){if(!this.provisioner)throw Error('Worker pools not configured');return this.provisioner.retire(nodeId,generation);}
   const identity=await this.options.registry.resolve(nodeId);if(!identity||identity.binding.generation!==generation||identity.binding.chatId!==binding.chatId||identity.binding.threadId!==binding.threadId)throw Error('Infrastructure identity mismatch');
   if(binding.status==='ready' && (!binding.sessionId||binding.sessionId!==identity.binding.sessionId))throw Error('Infrastructure session mismatch');
   this.options.registry.install({...identity,binding:{...identity.binding,status:binding.status}});await this.options.registry.persist(path.join(this.options.stateDirectory,'nodes.json'));
   return {nodeId,generation,projectId:binding.projectId??'',environmentId:'',endpoint:identity.endpoint,serviceId:binding.serviceId,volumeId:binding.volumeId,phase:'deploying' as const};
  });this.queue=task.catch(()=>undefined);return task;
 }
}
