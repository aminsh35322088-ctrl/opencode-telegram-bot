import { WORKER_CORE_COMMIT } from "../src/infrastructure/worker-core-release.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { NodeProvisioner, type NodeProvisionerOptions } from "../src/infrastructure/node-provisioner.js";
import type { NodeBinding } from "../src/control-plane/node-bindings.js";
const edges = <T>(nodes:T[]) => ({edges:nodes.map(node=>({node})),pageInfo:{hasNextPage:false}});
async function fixture() {
  const bindings = new Map<string,NodeBinding>();
  const services: Array<{id:string;name:string;projectId:string}> = [];
  const volumes: Array<{id:string;projectId:string;serviceId:string;environmentId:string}> = [];
  const domains = new Map<string,{id:string;domain:string}>();
  const calls: Array<{document:string;variables:Record<string,unknown>}> = [];
  let ambiguous = false; let rejected = false; let pendingReads=0; let attachPending=0; const waits:number[]=[];
  const filename=path.join(await mkdtemp(path.join(tmpdir(),'provisioner-')),'journal.json');
  const options:NodeProvisionerOptions={journalPath:filename,controlUrl:'https://control.up.railway.app',pools:[{projectId:'a',environmentId:'ea',capacity:2,region:'eu'},{projectId:'b',environmentId:'eb',capacity:2,region:'eu'}],
    wait:async ms=>{waits.push(ms);},lookup:async id=>bindings.get(id),ensureIdentity:async (_binding,create)=>create(),retireIdentity:async()=>{},
    request:async <T>(document:string,variables:Record<string,unknown>)=>{
      calls.push({document,variables}); const input=variables.input as Record<string,unknown>;
      let result: unknown;
      if(document.includes('query WorkerInventory')) {
        result={project:{id:variables.projectId,services:edges(services.filter(s=>s.projectId===variables.projectId)),volumes:edges(volumes.filter(v=>v.projectId===variables.projectId).map(v=>({id:v.id,volumeInstances:edges(pendingReads-->0?[]:[{volumeId:v.id,environmentId:v.environmentId,serviceId:v.serviceId,sizeMB:500,mountPath:'/data',isPendingDeletion:false}])})))},environment:{id:variables.environmentId,projectId:variables.projectId,serviceInstances:edges(services.filter(s=>s.projectId===variables.projectId).map(s=>({serviceId:s.id,domains:{serviceDomains:domains.has(s.id)?[domains.get(s.id)]:[]},latestDeployment:{id:'deployment-'+s.id}})))}};
      } else if(document.includes('mutation WorkerService')) {
        const service={id:'s'+services.length,name:input.name as string,projectId:input.projectId as string}; services.push(service);
        if(ambiguous){ambiguous=false;throw new Error('ambiguous network result');} result={serviceCreate:{id:service.id}};
      } else if(document.includes('mutation WorkerConfig')) {
        assert.equal(input.dockerfilePath,'Dockerfile.worker');
        const attached=volumes.some(v=>v.serviceId===variables.serviceId && v.environmentId===variables.environmentId);
        assert.deepEqual(input.multiRegionConfig,attached?undefined:{eu:{numReplicas:1}},'Existing dedicated Volume region must survive discovery/default changes');
        assert.equal(input.region,undefined);
        assert.equal(input.builder,undefined,'Dockerfile detection must not pass unsupported DOCKERFILE Builder enum');
        result={serviceInstanceUpdate:true};
      } else if(document.includes('mutation WorkerVolume(')) {
        const volume={id:'v'+volumes.length,projectId:input.projectId as string,serviceId:input.serviceId as string,environmentId:input.environmentId as string};volumes.push(volume);result={volumeCreate:{id:volume.id}};
      } else if(document.includes('mutation WorkerVolumeAttach')) {
        const patch=variables.patch as {volumes:Record<string,{sizeMB:number}>;services:Record<string,{volumeMounts:Record<string,unknown>}>};
        const volumeId=Object.keys(patch.volumes)[0]!;assert.equal(patch.volumes[volumeId]!.sizeMB,500);
        const volume=volumes.find(v=>v.id===volumeId)!;volume.environmentId=variables.environmentId as string;volume.serviceId=Object.keys(patch.services)[0]!;pendingReads=attachPending;result={environmentPatchCommit:'workflow'};
      } else if(document.includes('mutation WorkerDomain')) {
        const domain={id:'d'+domains.size,domain:'worker'+domains.size+'.up.railway.app'};domains.set(input.serviceId as string,domain);result={serviceDomainCreate:domain};
      } else if(document.includes('mutation WorkerLimits')) result={serviceInstanceLimitsUpdate:!rejected};
      else if(document.includes('mutation RetireService')) {services.splice(services.findIndex(s=>s.id===variables.id),1);result={serviceDelete:true};}
      else if(document.includes('mutation RetireVolume')) {volumes.splice(volumes.findIndex(v=>v.id===variables.volumeId),1);result={volumeDelete:true};}
      else result={mutation:true};
      return result as T;
    }};
  const add=(id:string)=>bindings.set(id,{nodeId:id,generation:1,chatId:-100,threadId:bindings.size+2,currentRevision:0,status:'reserved',createdAt:'now',updatedAt:'now'});
  return {options,controller:new NodeProvisioner(options),add,bindings,services,volumes,calls,filename,setAmbiguous:()=>{ambiguous=true;},setRejected:()=>{rejected=true;},setAttachPending:(reads:number)=>{attachPending=reads;},waits};
}
test('provision four isolated nodes 2+2, cap fifth and never return/persist secrets',async()=>{
  const f=await fixture();for(const id of ['one','two','three','four','five']) f.add(id);
  const nodes=await Promise.all(['one','two','three','four'].map(id=>f.controller.provision(id,1)));
  assert.deepEqual(nodes.map(n=>n.projectId),['a','a','b','b']);assert.equal(new Set(nodes.map(n=>n.volumeId)).size,4);
  await assert.rejects(f.controller.provision('five',1),/Maximum/);
  const contents=await readFile(f.filename,'utf8');assert.equal(contents.includes('NODE_SHARED_SECRET'),false);
  for(const call of f.calls.filter(c=>c.document.includes('WorkerVariables'))) {
    const vars=(call.variables.input as {variables:Record<string,string>}).variables;
    assert.equal(Object.keys(vars).some(name=>name.startsWith('RAILWAY_')),false);
    assert.deepEqual(Object.keys(vars).sort(),["CONTROL_PLANE_URL","NODE_GENERATION","NODE_ID","NODE_SHARED_SECRET"]);assert.ok(vars.NODE_SHARED_SECRET!.length>=48);
    assert.equal(contents.includes(vars.NODE_SHARED_SECRET!),false);
  }
  const sourceIndex=f.calls.findIndex(c=>c.document.includes('WorkerSource'));
  assert.ok(sourceIndex>f.calls.findIndex(c=>c.document.includes('WorkerVariables')));
  const before=f.calls.filter(c=>c.document.includes('WorkerSource')).length;
  await f.controller.provision('one',1);assert.equal(f.calls.filter(c=>c.document.includes('WorkerSource')).length,before);
});
test('ambiguous create reconciles fixed resource identity before retry',async()=>{
  const f=await fixture();f.add('one');f.setAmbiguous();await assert.rejects(f.controller.provision('one',1),/ambiguous/);
  await f.controller.provision('one',1);assert.equal(f.services.length,1);assert.equal(f.calls.filter(c=>c.document.includes('mutation WorkerService')).length,1);
});
test('fenced retire validates owned resources and is idempotent',async()=>{
  const f=await fixture();f.add('one');await assert.rejects(f.controller.provision('unknown',1),/authorization/);
  await f.controller.provision('one',1);await assert.rejects(f.controller.retire('one',1),/fenced/);
  const binding=f.bindings.get('one')!;binding.generation=2;binding.status='retiring';
  const retired=await f.controller.retire('one',2);assert.equal(retired.phase,'retired');assert.equal(f.services.length,0);assert.equal(f.volumes.length,0);
  assert.deepEqual(await f.controller.retire('one',2),retired);
});
test('false resource mutation fails before source or secrets installation',async()=>{
  const f=await fixture();f.add('one');f.setRejected();await assert.rejects(f.controller.provision('one',1),/rejected/);
  assert.equal(f.calls.some(c=>c.document.includes('WorkerVariables')||c.document.includes('WorkerSource')),false);
});
test('retirement reconciles a service created before an ambiguous API response',async()=>{
 const f=await fixture();f.add('one');f.setAmbiguous();await assert.rejects(f.controller.provision('one',1));
 const binding=f.bindings.get('one')!;binding.generation=2;binding.status='retiring';
 await f.controller.retire('one',2);assert.equal(f.services.length,0);
});

test('asynchronous volume activation retries inventory without duplicate mutation or premature secrets',async()=>{
 const f=await fixture();f.add('one');f.setAttachPending(2);await f.controller.provision('one',1);
 assert.deepEqual(f.waits,[1000,2000]);assert.equal(f.calls.filter(c=>c.document.includes('mutation WorkerVolumeAttach')).length,1);
 const source=f.calls.find(c=>c.document.includes('mutation WorkerSource'))!;
 assert.equal((source.variables.patch as {services:Record<string,{source:{commitSha:string}}>}).services.s0!.source.commitSha,WORKER_CORE_COMMIT);
});
test('unfinished volume activation retains journal and fails before credential distribution',async()=>{
 const f=await fixture();f.add('one');f.setAttachPending(10);await assert.rejects(f.controller.provision('one',1),/activation pending/);
 assert.equal(f.volumes.length,1);assert.equal(f.services.length,1);assert.equal(f.calls.some(c=>c.document.includes('WorkerVariables')||c.document.includes('WorkerSource')),false);
 assert.ok((await readFile(f.filename,'utf8')).includes('v0'));
});

test('Worker cleanup atomically replaces exact four fields without deployment or seed rotation and retries a lost response',async()=>{
 const f=await fixture();f.add('one');const binding=f.bindings.get('one')!;Object.assign(binding,{chatId:0,threadId:0,slot:1,clusterId:'cluster',status:'available'});
 const seed='durable-root-seed-'.repeat(4);f.options.ensureIdentity=async()=>seed;
 const node=await f.controller.provision('one',1);Object.assign(binding,{projectId:node.projectId,serviceId:node.serviceId,volumeId:node.volumeId});
 const request=f.options.request;const writes:Record<string,unknown>[]=[];let lose=true;const profiles:string[]=[];let seedReads=0;
 f.options.ensureIdentity=async (_binding,create)=>{seedReads++;assert.throws(create,/seed missing/);return seed;};
 f.options.request=async <T>(document:string,variables:Record<string,unknown>)=>{
  assert.equal(document.includes('variableDelete'),false);
  if(document.includes('WorkerVariableCleanup')){assert.match(document,/variableCollectionUpsert/);writes.push(variables);if(lose){lose=false;throw new Error('credential-sentinel');}return {variableCollectionUpsert:true} as T;}return request<T>(document,variables);
 };
 const selftest=async (_id:string,_generation:number,profile:'baseline'|'browser'|'network')=>{profiles.push(profile);return {profile,joined:true as const,success:true as const,runId:'a'.repeat(48)};};
 await assert.rejects(f.controller.cleanupDeprecatedWorkerVariables('one',1,selftest),error=>error instanceof Error&&error.message==='Worker variable cleanup failed');
 assert.equal(JSON.parse(await readFile(f.filename,'utf8')).nodes[0].workerVariablesContract,undefined);
 await f.controller.cleanupDeprecatedWorkerVariables('one',1,selftest);
 assert.equal(writes.length,2);assert.deepEqual(writes[0],writes[1]);assert.equal(seedReads,2);assert.equal(binding.generation,1);
 const input=writes[0]!.input as {replace:boolean;skipDeploys:boolean;variables:Record<string,string>};assert.equal(input.replace,true);assert.equal(input.skipDeploys,true);
 assert.deepEqual(input.variables,{NODE_ID:'one',NODE_GENERATION:'1',NODE_SHARED_SECRET:seed,CONTROL_PLANE_URL:'https://control.up.railway.app'});
 assert.deepEqual(Object.keys(input.variables).sort(),['CONTROL_PLANE_URL','NODE_GENERATION','NODE_ID','NODE_SHARED_SECRET']);
 await f.controller.cleanupDeprecatedWorkerVariables('one',1,selftest);assert.equal(writes.length,2);assert.equal(seedReads,2);
 assert.deepEqual(profiles.slice(0,3),['baseline','browser','network']);const journal=await readFile(f.filename,'utf8');assert.equal(journal.includes(seed),false);assert.equal(journal.includes('credential-sentinel'),false);assert.equal(JSON.parse(journal).nodes[0].workerVariablesContract,'identity-v1');
 binding.generation=2;await assert.rejects(f.controller.cleanupDeprecatedWorkerVariables('one',1,selftest));assert.equal(writes.length,2);
});
test('Worker cleanup refuses missing durable seed and false response; changed post-write identity cannot receive receipt',async()=>{
 const f=await fixture();f.add('one');const binding=f.bindings.get('one')!;Object.assign(binding,{chatId:0,threadId:0,slot:1,clusterId:'cluster',status:'available'});
 const node=await f.controller.provision('one',1);Object.assign(binding,{projectId:node.projectId,serviceId:node.serviceId,volumeId:node.volumeId});
 const good=async (_id:string,_generation:number,profile:'baseline'|'browser'|'network')=>({profile,joined:true as const,success:true as const,runId:'a'.repeat(48)});
 let writes=0;let changed=false;const request=f.options.request;f.options.request=async <T>(document:string,variables:Record<string,unknown>)=>{if(document.includes('WorkerVariableCleanup')){writes++;if(changed){binding.generation++;return {variableCollectionUpsert:true} as T;}return {variableCollectionUpsert:false} as T;}return request<T>(document,variables);};
 await assert.rejects(f.controller.cleanupDeprecatedWorkerVariables('one',1,good),/Worker variable cleanup failed/);assert.equal(writes,0);
 f.options.ensureIdentity=async()=> 'durable-seed-'.repeat(6);
 await assert.rejects(f.controller.cleanupDeprecatedWorkerVariables('one',1,good));assert.equal(writes,1);changed=true;
 await assert.rejects(f.controller.cleanupDeprecatedWorkerVariables('one',1,good));assert.equal(writes,2);assert.equal(JSON.parse(await readFile(f.filename,'utf8')).nodes[0].workerVariablesContract,undefined);
});
test('Worker cleanup fails closed on profile failure, ownership mismatch and canonical binding change',async()=>{
 const f=await fixture();f.add('one');const binding=f.bindings.get('one')!;Object.assign(binding,{chatId:0,threadId:0,slot:1,clusterId:'cluster',status:'available'});
 const node=await f.controller.provision('one',1);Object.assign(binding,{projectId:node.projectId,serviceId:node.serviceId,volumeId:node.volumeId});
 let deletes=0;const request=f.options.request;f.options.request=async <T>(document:string,variables:Record<string,unknown>)=>{if(document.includes('WorkerVariableCleanup'))deletes++;return request<T>(document,variables);};
 const good=async (_id:string,_generation:number,profile:'baseline'|'browser'|'network')=>({profile,joined:true as const,success:true as const,runId:'a'.repeat(48)});
 await assert.rejects(f.controller.cleanupDeprecatedWorkerVariables('one',1,async()=>{throw new Error('secret-sentinel');}),/Worker variable cleanup failed/);
 f.volumes[0]!.serviceId='foreign';await assert.rejects(f.controller.cleanupDeprecatedWorkerVariables('one',1,good));f.volumes[0]!.serviceId=node.serviceId!;
 await assert.rejects(f.controller.cleanupDeprecatedWorkerVariables('one',1,async(id,generation,profile)=>{if(profile==='network')binding.sessionId='now-bound';return good(id,generation,profile);}));assert.equal(deletes,0);
});
