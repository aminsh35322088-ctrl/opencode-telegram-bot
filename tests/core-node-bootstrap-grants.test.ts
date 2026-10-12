import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {captureNodeRegistry} from '../src/infrastructure/node-registry.js';
import {NodeBootstrapGrantStore} from '../src/infrastructure/node-bootstrap-grants.js';

test('bootstrap grant rejects malformed bound Topic identities before minting a capability',async()=>{
 const home=await mkdtemp(path.join(tmpdir(),'bootstrap-grant-invalid-'));const registry=captureNodeRegistry({});const grants=new NodeBootstrapGrantStore(registry,path.join(home,'nodes.json'));
 for(const identity of [{nodeId:'slot',generation:1,chatId:-100,threadId:-1},{nodeId:'slot',generation:1,chatId:0,threadId:2},{nodeId:'slot',generation:1,chatId:-100,threadId:1}])await assert.rejects(grants.issue({identity,endpoint:'https://worker.up.railway.app',secret:'s'.repeat(64),serviceId:'service',projectId:'project'}),/identity/);
});

test('bootstrap grant is one-use, service/project scoped, and installs next registry identity before returning secret',async()=>{
 const home=await mkdtemp(path.join(tmpdir(),'bootstrap-grant-'));const registry=captureNodeRegistry({});
 const grants=new NodeBootstrapGrantStore(registry,path.join(home,'nodes.json'),()=>1000);
 const target={nodeId:'slot',generation:2,chatId:-100,threadId:22};const secret='next-secret-'.repeat(8);
 const token=await grants.issue({identity:target,endpoint:'https://worker.up.railway.app',secret,serviceId:'service',projectId:'project'});
 await assert.rejects(grants.consume({bootstrapToken:token,serviceId:'foreign',projectId:'project'}),/scope/);
 const result=await grants.consume({bootstrapToken:token,serviceId:'service',projectId:'project'});
 assert.deepEqual(result,{version:1,identity:target,secret});const installed=await registry.resolve('slot');assert.equal(installed?.secret,secret);assert.equal(installed?.binding.generation,2);assert.equal(installed?.binding.status,'provisioning');
 await assert.rejects(grants.consume({bootstrapToken:token,serviceId:'service',projectId:'project'}),/grant/);
});
