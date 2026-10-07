import assert from 'node:assert/strict';
import {test} from 'node:test';
import {resolveWorkerPools} from '../src/infrastructure/worker-pools.js';
const project=(id:string,environment:string)=>({id,name:id,environments:{edges:[{node:{id:environment,name:environment}}],pageInfo:{hasNextPage:false}}});
const options={workspaceId:'workspace',controlProjectId:'control',controlEnvironmentId:'production',workerProjectId:'existing',workerEnvironmentId:'validation',region:'eu'};
test('root setup verifies existing control and validation pools without project mutations',async()=>{
 let calls=0;
 const request=async<T>(document:string)=>{calls++;assert.ok(document.startsWith('query WorkerPools'));return {workspace:{id:'workspace',projects:{edges:[project('control','production'),project('existing','validation')].map(node=>({node})),pageInfo:{hasNextPage:false}}}} as T;};
 const pools=await resolveWorkerPools({...options,request});
 assert.deepEqual(pools.map(p=>[p.projectId,p.environmentId,p.capacity]),[['control','production',undefined],['existing','validation',undefined]]);
 assert.deepEqual(await resolveWorkerPools({...options,request}),pools);assert.equal(calls,2);
});
test('root setup refuses foreign projects, wrong environments and incomplete inventory',async()=>{
 const request=async<T>()=>({workspace:{id:'workspace',projects:{edges:[project('control','production'),project('existing','validation')].map(node=>({node})),pageInfo:{hasNextPage:false}}}} as T);
 for(const invalid of [{workerProjectId:'foreign'},{controlEnvironmentId:'wrong'},{workerProjectId:'control'}])await assert.rejects(resolveWorkerPools({...options,...invalid,request}));
 await assert.rejects(resolveWorkerPools({...options,request:async<T>()=>({workspace:{id:'workspace',projects:{edges:[],pageInfo:{hasNextPage:true}}}} as T)}),/Incomplete/);
});
test('normal bootstrap discovers workspace and stable Worker environment without custom IDs',async()=>{
 const calls:string[]=[];
 const control=project('portable-control','portable-production');
 const worker={id:'portable-worker',name:'opencode-topic-validation',environments:{pageInfo:{hasNextPage:false},edges:[{node:{id:'unrelated-env',name:'staging'}},{node:{id:'portable-validation',name:'validation'}}]}};
 const request=async<T>(document:string,variables:Record<string,unknown>)=>{
  calls.push(document);
  if(document.startsWith('query WorkerWorkspace')){assert.equal(variables.projectId,'portable-control');return {project:{workspaceId:'discovered-workspace'}} as T;}
  assert.equal(variables.workspaceId,'discovered-workspace');
  return {workspace:{id:'discovered-workspace',projects:{pageInfo:{hasNextPage:false},edges:[control,worker].map(node=>({node}))}}} as T;
 };
 const pools=await resolveWorkerPools({controlProjectId:'portable-control',controlEnvironmentId:'portable-production',region:'eu',request});
 assert.equal(pools[1].environmentId,'portable-validation');assert.equal(calls.length,2);
});

test('configured flat pool supports three projects with independent policy limits',async()=>{
 const pools=[{projectId:'control',environmentId:'production',region:'eu',capacity:1},{projectId:'existing',environmentId:'validation',region:'eu',capacity:3},{projectId:'third',environmentId:'third-env',region:'us'}];
 const request=async<T>()=>({workspace:{id:'workspace',projects:{edges:[project('control','production'),project('existing','validation'),project('third','third-env')].map(node=>({node})),pageInfo:{hasNextPage:false}}}} as T);
 assert.deepEqual(await resolveWorkerPools({...options,pools,request}),pools);
});
test('single eligible project is valid and does not require a validation project',async()=>{
 const request=async<T>()=>({workspace:{id:'workspace',projects:{edges:[project('control','production')].map(node=>({node})),pageInfo:{hasNextPage:false}}}} as T);
 assert.deepEqual((await resolveWorkerPools({workspaceId:'workspace',controlProjectId:'control',controlEnvironmentId:'production',region:'eu',request})).map(p=>p.projectId),['control']);
});
