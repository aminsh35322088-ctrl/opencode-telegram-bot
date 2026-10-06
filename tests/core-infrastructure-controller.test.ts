import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {captureNodeRegistry} from '../src/infrastructure/node-registry.js';
import {InfrastructureController} from '../src/infrastructure/node-controller.js';
const identity=(nodeId:string,status='ready',generation=1)=>({binding:{nodeId,generation,chatId:1,threadId:2,status,sessionId:'session'},endpoint:'https://worker.up.railway.app',secret:'s'.repeat(64)});
test('retired identities release capacity while old identity stays fenced',()=>{
 const registry=captureNodeRegistry({});
 for(let i=0;i<4;i++)registry.install({...identity(String(i),'retired',2),binding:{...identity(String(i),'retired',2).binding,threadId:i+2}});
 registry.install({...identity('replacement'),binding:{...identity('replacement').binding,threadId:8}});
 assert.equal(registry.metadata().filter(n=>n.status!=='retired').length,1);
 assert.throws(()=>registry.install(identity('0','ready',1)),/Stale/);
});
test('controller reconcile trusts canonical identity but rejects an invented session',async()=>{
 const home=await mkdtemp(path.join(tmpdir(),'infrastructure-controller-'));
 const binding={...identity('owned','provisioning').binding,currentRevision:4,createdAt:'now',updatedAt:'now'};
 const filename=path.join(home,'bindings.json');await writeFile(filename,JSON.stringify({version:1,bindings:[binding]}));
 const registry=captureNodeRegistry({CONTROL_NODE_REGISTRY:JSON.stringify([identity('owned','provisioning')])});
 const controller=new InfrastructureController({registry,stateDirectory:home,bindingFilename:filename,request:async()=>{throw Error('unexpected API');}});
 await assert.rejects(controller.request('provision','owned',1),/not configured/);
 await controller.request('reconcile','owned',1);
 binding.status='ready';binding.sessionId='invented';await writeFile(filename,JSON.stringify({version:1,bindings:[binding]}));
 await assert.rejects(controller.request('reconcile','owned',1),/session/);
 binding.sessionId='session';await writeFile(filename,JSON.stringify({version:1,bindings:[binding]}));
 const result=await controller.request('reconcile','owned',1);assert.equal(result.nodeId,'owned');assert.equal((await registry.resolve('owned'))?.binding.status,'ready');
 assert.equal((await readFile(path.join(home,'nodes.json'),'utf8')).includes('s'.repeat(64)),true);
 assert.equal(JSON.stringify(result).includes('s'.repeat(64)),false);
});

test('Root handoff fences old identity and confirms retirement before rotating Worker variables; failed retirement is retryable',async()=>{
 const {NodeBindingStore}=await import('../src/control-plane/node-bindings.js');
 const {WORKER_CORE_COMMIT}=await import('../src/infrastructure/worker-core-release.js');
 const home=await mkdtemp(path.join(tmpdir(),'root-handoff-'));const filename=path.join(home,'bindings.json');
 const store=new NodeBindingStore(filename);let binding=(await store.ensurePoolSlots())[0]!;
 binding=await store.update(binding.nodeId,1,{status:'pool-provisioning'});
 const registry=captureNodeRegistry({});const events:string[]=[];let retirementFails=true;let oldSecret='';
 const edge=<T>(nodes:T[])=>({edges:nodes.map(node=>({node})),pageInfo:{hasNextPage:false}});
 const controller=new InfrastructureController({registry,stateDirectory:home,bindingFilename:filename,coreCommit:WORKER_CORE_COMMIT,controlUrl:'https://control.up.railway.app',pools:[{projectId:'a',environmentId:'ea',capacity:2,region:'eu'},{projectId:'b',environmentId:'eb',capacity:2,region:'eu'}],
 request:async <T>(document:string,variables:Record<string,unknown>)=>{
  if(document.includes('WorkerInventory'))return {project:{id:variables.projectId,services:edge([{id:'service',name:'topic-node-'+binding.nodeId}]),volumes:edge([{id:'volume',volumeInstances:edge([{volumeId:'volume',environmentId:variables.environmentId,serviceId:'service',sizeMB:500,mountPath:'/data',isPendingDeletion:false}])}])},environment:{id:variables.environmentId,projectId:variables.projectId,serviceInstances:edge([{serviceId:'service',domains:{serviceDomains:[{id:'domain',domain:'worker.up.railway.app'}]},latestDeployment:{id:'deployment'}}])}} as T;
  if(document.includes('WorkerVariables')){
   const env=(variables.input as {variables:Record<string,string>}).variables;
   events.push('variables:'+env.NODE_GENERATION);
   if(env.NODE_GENERATION==='1'){assert.equal(env.NODE_CHAT_ID,'0');assert.equal(env.NODE_THREAD_ID,'0');oldSecret=env.NODE_SHARED_SECRET!;}
   else{assert.equal(env.NODE_GENERATION,'2');assert.equal(env.NODE_CHAT_ID,'-100');assert.notEqual(env.NODE_SHARED_SECRET,oldSecret);assert.ok(events.indexOf('retired')<events.indexOf('variables:2'));}
  }
  if(document.includes('WorkerSource')){const patch=variables.patch as {services:Record<string,{source:{commitSha:string}}>};assert.equal(patch.services.service!.source.commitSha,WORKER_CORE_COMMIT);}
  return {mutation:true} as T;
 },retireNode:async identity=>{
  events.push('retire');assert.equal(identity.binding.generation,1);assert.equal(identity.binding.chatId,0);assert.equal(identity.binding.threadId,0);assert.equal(identity.secret,oldSecret);
  const fenced=await registry.resolve(binding.nodeId);assert.equal(fenced?.binding.generation,2);assert.equal(fenced?.binding.status,'retired');
  if(retirementFails)throw new Error('Core join unconfirmed');events.push('retired');
 }});
 await controller.request('provision',binding.nodeId,1);binding=await store.update(binding.nodeId,1,{status:'available',endpoint:'https://worker.up.railway.app'});await controller.request('reconcile',binding.nodeId,1);
 binding=await store.reserve(-100,2);assert.equal(binding.generation,2);binding=await store.update(binding.nodeId,2,{status:'provisioning'});
 await assert.rejects(controller.request('provision',binding.nodeId,2),/join unconfirmed/);assert.equal(events.includes('variables:2'),false);
 assert.equal((await registry.resolve(binding.nodeId))?.binding.status,'retired');retirementFails=false;
 await controller.request('provision',binding.nodeId,2);assert.equal(events.filter(event=>event==='retire').length,2);assert.equal(events.filter(event=>event==='variables:2').length,1);
 const current=await registry.resolve(binding.nodeId);assert.equal(current?.binding.generation,2);assert.equal(current?.binding.chatId,-100);assert.notEqual(current?.secret,oldSecret);
});

test('provision requests await one explicit pool discovery without autonomous retries',async()=>{
 const {NodeBindingStore}=await import('../src/control-plane/node-bindings.js');
 const home=await mkdtemp(path.join(tmpdir(),'root-pools-'));const filename=path.join(home,'bindings.json');const store=new NodeBindingStore(filename);const binding=(await store.ensurePoolSlots())[0]!;
 const controller=new InfrastructureController({registry:captureNodeRegistry({}),stateDirectory:home,bindingFilename:filename,request:async()=>{throw Error('unexpected API');}});
 let reject!:(error:Error)=>void;const discovery=new Promise<void>((_resolve,fail)=>{reject=fail;});controller.waitForPoolConfiguration(discovery);
 let finished=false;const request=controller.request('provision',binding.nodeId,1).finally(()=>{finished=true;});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);const failure=new Error('Pool inventory unavailable');reject(failure);await assert.rejects(request,error=>error===failure);
 await assert.rejects(controller.request('provision',binding.nodeId,1),error=>error===failure);
});
