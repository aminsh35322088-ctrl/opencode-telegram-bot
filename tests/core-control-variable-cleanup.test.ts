import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cleanupDeprecatedControlVariables} from '../src/infrastructure/control-variable-cleanup.js';
test('cleanup deletes only obsolete application configuration without reading any secret values',async()=>{
 const requests:Array<{document:string,variables:Record<string,unknown>}>=[];
 await cleanupDeprecatedControlVariables({projectId:'p',environmentId:'e',serviceId:'s',names:['CONTROL_WORKSPACE_ID','CONTROL_INFRASTRUCTURE_ENABLED','CONTROL_CLUSTER_BOOTSTRAP_ENABLED','TOPIC_NODE_CREATION_ENABLED','WORKER_POOL_POLICY','WORKER_WARM_CAPACITY','TELEGRAM_ALLOWED_USER_ID','NODE_ENV','PORT','RAILWAY_API_TOKEN','RAILWAY_SERVICE_ID','TELEGRAM_BOT_TOKEN','TELEGRAM_USER_ID','USER_OPTION'],request:async<T>(document:string,variables:Record<string,unknown>)=>{requests.push({document,variables});return {removed0:true,removed1:true,removed2:true,removed3:true,removed4:true,removed5:true,removed6:true,removed7:true,removed8:true,removed9:true} as T;}});
 assert.equal(requests.length,1);const request=requests[0]!;
 assert.ok(request.document.startsWith('mutation ControlVariableCleanup'));
 assert.equal(request.document.includes('query'),false);assert.equal(request.document.includes('variableDelete'),true);
 assert.deepEqual(Object.values(request.variables).filter(v=>typeof v==='string'&&v!=='p'&&v!=='e'&&v!=='s').sort(),['CONTROL_CLUSTER_BOOTSTRAP_ENABLED','CONTROL_INFRASTRUCTURE_ENABLED','CONTROL_WORKSPACE_ID','NODE_ENV','PORT','TELEGRAM_ALLOWED_USER_ID','TOPIC_NODE_CREATION_ENABLED','WORKER_POOL_POLICY','WORKER_WARM_CAPACITY']);
});
test('no obsolete variables requires no API request; incomplete ownership refuses deletion',async()=>{
 let calls=0;const request=async<T>()=>{calls++;return {} as T;};
 await cleanupDeprecatedControlVariables({projectId:'p',environmentId:'e',serviceId:'s',names:['RAILWAY_API_TOKEN'],request});assert.equal(calls,0);
 await assert.rejects(cleanupDeprecatedControlVariables({projectId:'',environmentId:'e',serviceId:'s',names:['PORT'],request}),/identity/);assert.equal(calls,0);
});
test('a failed removal is surfaced and never replaced with an empty secret collection',async()=>{
 await assert.rejects(cleanupDeprecatedControlVariables({projectId:'p',environmentId:'e',serviceId:'s',names:['PORT'],request:async<T>()=>({removed0:false} as T)}),/rejected/);
});
