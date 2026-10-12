import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createWorkerPool,resolveWorkerPools} from '../src/infrastructure/worker-pools.js';
const project=(id:string,environment:string)=>({id,name:id,environments:{edges:[{node:{id:environment,name:environment}}],pageInfo:{hasNextPage:false}}});
const options={workspaceId:'workspace',controlProjectId:'control',controlEnvironmentId:'production',workerProjectId:'existing',workerEnvironmentId:'validation',region:'eu'};
test('root setup verifies existing Worker pool without ever using the Control project as a pool',async()=>{
 let calls=0;
 const request=async<T>(document:string)=>{calls++;assert.ok(document.startsWith('query WorkerPools'));return {workspace:{id:'workspace',projects:{edges:[project('control','production'),project('existing','validation')].map(node=>({node})),pageInfo:{hasNextPage:false}}}} as T;};
 const pools=await resolveWorkerPools({...options,request});
 assert.deepEqual(pools.map(p=>[p.projectId,p.environmentId,p.capacity]),[['existing','validation',undefined]]);
 assert.deepEqual(await resolveWorkerPools({...options,request}),pools);assert.equal(calls,2);
});
test('root setup refuses foreign projects, wrong environments and incomplete inventory',async()=>{
 const request=async<T>()=>({workspace:{id:'workspace',projects:{edges:[project('control','production'),project('existing','validation')].map(node=>({node})),pageInfo:{hasNextPage:false}}}} as T);
 for(const invalid of [{workerProjectId:'foreign'},{workerEnvironmentId:'wrong'},{workerProjectId:'control'}])await assert.rejects(resolveWorkerPools({...options,...invalid,request}));
 await assert.rejects(resolveWorkerPools({...options,pools:[{projectId:'control',environmentId:'production',region:'eu'}],request}),/Control project/);
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
 assert.equal(pools.length,1);assert.equal(pools[0]!.projectId,'portable-worker');assert.equal(pools[0]!.environmentId,'portable-validation');assert.equal(calls.length,2);
});

test('configured flat Worker pools support independent policy limits without the Control project',async()=>{
 const pools=[{projectId:'existing',environmentId:'validation',region:'eu',capacity:3},{projectId:'third',environmentId:'third-env',region:'us'}];
 const request=async<T>()=>({workspace:{id:'workspace',projects:{edges:[project('control','production'),project('existing','validation'),project('third','third-env')].map(node=>({node})),pageInfo:{hasNextPage:false}}}} as T);
 assert.deepEqual(await resolveWorkerPools({...options,pools,request}),pools);
});
test('a selected workspace without the Control project can start with no Worker pools',async()=>{
 const request=async<T>()=>({workspace:{id:'worker-workspace',projects:{edges:[],pageInfo:{hasNextPage:false}}}} as T);
 assert.deepEqual(await resolveWorkerPools({workspaceId:'worker-workspace',controlProjectId:'control',controlEnvironmentId:'production',region:'eu',request}),[]);
});

test('Control project alone is never eligible as a Worker pool',async()=>{
 const request=async<T>()=>({workspace:{id:'workspace',projects:{edges:[project('control','production')].map(node=>({node})),pageInfo:{hasNextPage:false}}}} as T);
 assert.deepEqual((await resolveWorkerPools({workspaceId:'workspace',controlProjectId:'control',controlEnvironmentId:'production',region:'eu',request})).map(p=>p.projectId),[]);
});


test('capacity rollover creates the next deterministic Worker project in the selected workspace',async()=>{
 const calls:Array<{document:string;variables:Record<string,unknown>}>=[];
 const request=async<T>(document:string,variables:Record<string,unknown>)=>{
  calls.push({document,variables});
  if(document.startsWith('query WorkerPoolExpansionInventory'))return {projects:{pageInfo:{hasNextPage:false},edges:[{node:{id:'control',name:'opencode-telegram-bot'}}]}} as T;
  if(document.startsWith('mutation WorkerPoolCreate')){assert.deepEqual(variables,{input:{name:'opencode-topic-01',workspaceId:'workspace'}});return {projectCreate:{id:'worker-project',name:'opencode-topic-01'}} as T;}
  assert.ok(document.startsWith('query WorkerPoolCreated'));
  assert.deepEqual(variables,{projectId:'worker-project'});
  return {project:{id:'worker-project',name:'opencode-topic-01',environments:{pageInfo:{hasNextPage:false},edges:[{node:{id:'worker-production',name:'production'}}]}}} as T;
 };
 const pool=await createWorkerPool({workspaceId:'workspace',region:'eu',request});
 assert.deepEqual(pool,{projectId:'worker-project',environmentId:'worker-production',region:'eu'});
 assert.equal(calls.length,3);
});

test('pool expansion adopts an untracked managed project after an ambiguous create result',async()=>{
 let creates=0;
 const request=async<T>(document:string,variables:Record<string,unknown>)=>{
  if(document.startsWith('query WorkerPoolExpansionInventory'))return {projects:{pageInfo:{hasNextPage:false},edges:[{node:{id:'control',name:'opencode-telegram-bot'}},{node:{id:'recovered',name:'opencode-topic-01'}}]}} as T;
  if(document.startsWith('mutation WorkerPoolCreate')){creates++;throw new Error('must reconcile instead of creating');}
  assert.ok(document.startsWith('query WorkerPoolCreated'));assert.deepEqual(variables,{projectId:'recovered'});
  return {project:{id:'recovered',name:'opencode-topic-01',environments:{pageInfo:{hasNextPage:false},edges:[{node:{id:'production-recovered',name:'production'}}]}}} as T;
 };
 const pool=await createWorkerPool({workspaceId:'workspace',region:'eu',excludedProjectIds:new Set(['control']),request});
 assert.deepEqual(pool,{projectId:'recovered',environmentId:'production-recovered',region:'eu'});assert.equal(creates,0);
});
