import assert from 'node:assert/strict';
import {test} from 'node:test';
import {resolveControlUrl} from '../src/infrastructure/control-location.js';
test('Control discovery uses only owned service domains and never inspects variables',async()=>{
 let calls=0;
 const request=async<T>(document:string)=>{calls++;assert.ok(!document.includes('variables'));return {environment:{id:'env',projectId:'control',serviceInstances:{pageInfo:{hasNextPage:false},edges:[{node:{serviceId:'bot',domains:{serviceDomains:[{domain:'owned.up.railway.app',targetPort:8080}]}}}]}}} as T;};
 assert.equal(await resolveControlUrl({request,projectId:'control',environmentId:'env',serviceId:'bot'}),'https://owned.up.railway.app');assert.equal(calls,1);
 await assert.rejects(resolveControlUrl({request,projectId:'foreign',environmentId:'env',serviceId:'bot'}),/ownership/);
 await assert.rejects(resolveControlUrl({request,projectId:'control',environmentId:'env',serviceId:'other'}),/service/);
});
test('existing explicit domain is verified without provisioning unrelated resources',async()=>{
 const request=async<T>():Promise<T>=>{throw Error('unexpected API');};
 assert.equal(await resolveControlUrl({request,projectId:'control',environmentId:'env',serviceId:'bot',publicUrl:'https://owned.up.railway.app'}),'https://owned.up.railway.app');
 for(const publicUrl of ['https://other.invalid','http://owned.up.railway.app','https://owned.up.railway.app/raw','https://user@owned.up.railway.app'])await assert.rejects(resolveControlUrl({request,projectId:'control',environmentId:'env',serviceId:'bot',publicUrl}));
});
