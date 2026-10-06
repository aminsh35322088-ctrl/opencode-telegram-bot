import assert from 'node:assert/strict';
import {test} from 'node:test';
import {resolveWorkerPools} from '../src/infrastructure/worker-pools.js';
const project=(id:string,environment:string)=>({id,name:id,environments:{edges:[{node:{id:environment,name:environment}}],pageInfo:{hasNextPage:false}}});
const options={workspaceId:'workspace',controlProjectId:'control',controlEnvironmentId:'production',workerProjectId:'existing',workerEnvironmentId:'validation',region:'eu'};
test('root setup verifies existing control and validation pools without project mutations',async()=>{
 let calls=0;
 const request=async<T>(document:string)=>{calls++;assert.ok(document.startsWith('query WorkerPools'));return {workspace:{id:'workspace',projects:{edges:[project('control','production'),project('existing','validation')].map(node=>({node})),pageInfo:{hasNextPage:false}}}} as T;};
 const pools=await resolveWorkerPools({...options,request});
 assert.deepEqual(pools.map(p=>[p.projectId,p.environmentId,p.capacity]),[['control','production',2],['existing','validation',2]]);
 assert.deepEqual(await resolveWorkerPools({...options,request}),pools);assert.equal(calls,2);
});
test('root setup refuses foreign projects, wrong environments and incomplete inventory',async()=>{
 const request=async<T>()=>({workspace:{id:'workspace',projects:{edges:[project('control','production'),project('existing','validation')].map(node=>({node})),pageInfo:{hasNextPage:false}}}} as T);
 for(const invalid of [{workerProjectId:'foreign'},{controlEnvironmentId:'wrong'},{workerProjectId:'control'}])await assert.rejects(resolveWorkerPools({...options,...invalid,request}));
 await assert.rejects(resolveWorkerPools({...options,request:async<T>()=>({workspace:{id:'workspace',projects:{edges:[],pageInfo:{hasNextPage:true}}}} as T)}),/Incomplete/);
});
