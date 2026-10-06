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
  return {controller:new NodeProvisioner(options),add,bindings,services,volumes,calls,filename,setAmbiguous:()=>{ambiguous=true;},setRejected:()=>{rejected=true;},setAttachPending:(reads:number)=>{attachPending=reads;},waits};
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
    assert.equal(vars.NODE_CHAT_ID,'-100');assert.ok(vars.NODE_SHARED_SECRET!.length>=48);
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
 assert.equal((source.variables.patch as {services:Record<string,{source:{commitSha:string}}>}).services.s0!.source.commitSha,'ac683948c3cd3ee697a6f38354e7e1a02e82cc30');
});
test('unfinished volume activation retains journal and fails before credential distribution',async()=>{
 const f=await fixture();f.add('one');f.setAttachPending(10);await assert.rejects(f.controller.provision('one',1),/activation pending/);
 assert.equal(f.volumes.length,1);assert.equal(f.services.length,1);assert.equal(f.calls.some(c=>c.document.includes('WorkerVariables')||c.document.includes('WorkerSource')),false);
 assert.ok((await readFile(f.filename,'utf8')).includes('v0'));
});
