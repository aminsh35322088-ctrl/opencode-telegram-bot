import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cleanupDeprecatedControlVariables} from '../src/infrastructure/control-variable-cleanup.js';
test('cleanup deletes only obsolete application configuration without reading any secret values',async()=>{
 const requests:Array<{document:string,variables:Record<string,unknown>}>=[];
 await cleanupDeprecatedControlVariables({projectId:'p',environmentId:'e',serviceId:'s',names:['CONTROL_WORKSPACE_ID','CONTROL_INFRASTRUCTURE_ENABLED','PORT','RAILWAY_API_TOKEN','RAILWAY_SERVICE_ID','TELEGRAM_BOT_TOKEN','USER_OPTION'],request:async<T>(document:string,variables:Record<string,unknown>)=>{requests.push({document,variables});return {removed0:true,removed1:true,removed2:true} as T;}});
 assert.equal(requests.length,1);const request=requests[0]!;
 assert.ok(request.document.startsWith('mutation ControlVariableCleanup'));
 assert.equal(request.document.includes('query'),false);assert.equal(request.document.includes('variableDelete'),true);
 assert.deepEqual(Object.values(request.variables).filter(v=>typeof v==='string'&&v!=='p'&&v!=='e'&&v!=='s').sort(),['CONTROL_INFRASTRUCTURE_ENABLED','CONTROL_WORKSPACE_ID','PORT']);
});
test('no obsolete variables requires no API request; incomplete ownership refuses deletion',async()=>{
 let calls=0;const request=async<T>()=>{calls++;return {} as T;};
 await cleanupDeprecatedControlVariables({projectId:'p',environmentId:'e',serviceId:'s',names:['RAILWAY_API_TOKEN'],request});assert.equal(calls,0);
 await assert.rejects(cleanupDeprecatedControlVariables({projectId:'',environmentId:'e',serviceId:'s',names:['PORT'],request}),/identity/);assert.equal(calls,0);
});
test('a failed removal is surfaced and never replaced with an empty secret collection',async()=>{
 await assert.rejects(cleanupDeprecatedControlVariables({projectId:'p',environmentId:'e',serviceId:'s',names:['PORT'],request:async<T>()=>({removed0:false} as T)}),/rejected/);
});
