import assert from 'node:assert/strict';
import {test} from 'node:test';
import {resolveWorkerPools,createWorkerPool} from '../src/infrastructure/worker-pools.js';
const edges=<T>(nodes:T[])=>({edges:nodes.map(node=>({node})),pageInfo:{hasNextPage:false}});
const deleted={id:'deleted',name:'opencode-topic-01',deletedAt:'2026-10-15T10:00:00Z',environments:edges([{id:'old-env',name:'production'}])};
test('deleted projects returned by workspace inventory are not usable Worker pools',async()=>{
 const deletedIds:string[]=[];
 const pools=await resolveWorkerPools({workspaceId:'workspace',controlProjectId:'control',controlEnvironmentId:'production',region:'eu',onDeletedProjects:ids=>{deletedIds.push(...ids);},request:async<T>()=>({workspace:{id:'workspace',projects:edges([deleted])}} as T)});
 assert.deepEqual(pools,[]);assert.deepEqual(deletedIds,['deleted']);
});
test('pool creation does not adopt a soft-deleted project or reserve its name',async()=>{
 const request=async<T>(document:string,variables:Record<string,unknown>)=>{
  if(document.startsWith('query WorkerPoolExpansionInventory'))return {projects:edges([deleted])} as T;
  if(document.startsWith('mutation WorkerPoolCreate')){assert.equal((variables.input as {name:string}).name,'opencode-topic-01');return {projectCreate:{id:'new',name:'opencode-topic-01'}} as T;}
  assert.equal(variables.projectId,'new');return {project:{id:'new',name:'opencode-topic-01',environments:edges([{id:'new-env',name:'production'}])}} as T;
 };
 assert.equal((await createWorkerPool({workspaceId:'workspace',region:'eu',request})).projectId,'new');
});
