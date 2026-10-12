import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import {createServer} from 'node:net';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {ChildProcess} from 'node:child_process';
import {captureNodeRegistry} from '../src/infrastructure/node-registry.js';
import {NodeProtocol} from '../src/control-plane/node-protocol.js';
import {startNodeGateway} from '../src/infrastructure/node-gateway.js';

async function freePort():Promise<number>{const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('port unavailable');const port=address.port;await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));return port;}

test('root gateway exposes only scoped one-time Worker bootstrap credentials at /nodes/bootstrap',async()=>{
 const home=await mkdtemp(path.join(tmpdir(),'gateway-bootstrap-'));const registry=captureNodeRegistry({});const protocol=new NodeProtocol(path.join(home,'replay.json'));const child=Object.assign(new EventEmitter(),{connected:true,send:()=>true}) as unknown as ChildProcess;
 const calls:unknown[]=[];const bootstrap={consume:async(input:{bootstrapToken:string;serviceId:string;projectId:string})=>{calls.push(input);if(input.bootstrapToken!=='t'.repeat(64))throw new Error('denied');return {version:1 as const,identity:{nodeId:'slot',generation:2,chatId:-100,threadId:22},secret:'s'.repeat(64)};}};
 const port=await freePort();const stop=startNodeGateway(child,registry,protocol,port,undefined,undefined,bootstrap);
 try{let response:Response|undefined;for(let attempt=0;attempt<20;attempt++){try{response=await fetch(`http://127.0.0.1:${port}/nodes/bootstrap`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrapToken:'t'.repeat(64),serviceId:'service',projectId:'project'})});break;}catch{await new Promise(resolve=>setTimeout(resolve,10));}}assert.ok(response);assert.equal(response!.status,200);assert.deepEqual(await response!.json(),{version:1,identity:{nodeId:'slot',generation:2,chatId:-100,threadId:22},secret:'s'.repeat(64)});assert.deepEqual(calls,[{bootstrapToken:'t'.repeat(64),serviceId:'service',projectId:'project'}]);
  const denied=await fetch(`http://127.0.0.1:${port}/nodes/bootstrap`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrapToken:'bad',serviceId:'service',projectId:'project'})});assert.equal(denied.status,403);
 }finally{stop();registry.dispose();}
});
