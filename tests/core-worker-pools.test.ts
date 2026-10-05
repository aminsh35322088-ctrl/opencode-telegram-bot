import assert from 'node:assert/strict';
import {test} from 'node:test';
import {resolveWorkerPools} from '../src/infrastructure/worker-pools.js';
test('root setup reuses validation and reconciles a single independent Worker project',async()=>{
 const projects=[{id:'existing',name:'opencode-topic-validation',environments:{edges:[{node:{id:'validation',name:'validation'}}],pageInfo:{hasNextPage:false}}}];let creates=0;
 const request=async<T>(document:string,variables:Record<string,unknown>)=>{
  if(document.includes('query WorkerPools'))return {workspace:{id:'workspace',projects:{edges:projects.map(node=>({node})),pageInfo:{hasNextPage:false}}}} as T;
  creates++;const input=variables.input as {name:string;workspaceId:string;isPublic:boolean};assert.equal(input.workspaceId,'workspace');assert.equal(input.isPublic,false);
  const node={id:'new',name:input.name,environments:{edges:[{node:{id:'production',name:'production'}}],pageInfo:{hasNextPage:false}}};projects.push(node);return {projectCreate:node} as T;
 };
 const options={request,workspaceId:'workspace',workerProjectId:'existing',workerEnvironmentId:'validation',region:'eu'};
 const pools=await resolveWorkerPools(options);assert.deepEqual(pools.map(p=>[p.projectId,p.environmentId,p.capacity]),[['existing','validation',3],['new','production',1]]);
 assert.deepEqual(await resolveWorkerPools(options),pools);assert.equal(creates,1);
});
test('root setup refuses foreign validation project and incomplete inventory before mutation',async()=>{
 let calls=0;const request=async<T>()=>{calls++;return {workspace:{id:'workspace',projects:{edges:[],pageInfo:{hasNextPage:false}}}} as T;};
 await assert.rejects(resolveWorkerPools({request,workspaceId:'workspace',workerProjectId:'foreign',workerEnvironmentId:'validation',region:'eu'}),/validation/);assert.equal(calls,1);
});
