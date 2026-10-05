import {test} from "node:test";
import assert from "node:assert/strict";
import {captureNodeRegistry} from "../src/infrastructure/node-registry.js";

test("root identity capture strips environment and exports metadata without keys",async()=>{
 const secret="syntheticnodeidentity".repeat(4);
 const binding={nodeId:"node",generation:1,chatId:1,threadId:2,status:"ready",sessionId:"s"};
 const environment={CONTROL_NODE_REGISTRY:JSON.stringify([{binding,endpoint:"https://owned.up.railway.app",secret}])};
 const registry=captureNodeRegistry(environment);
 assert.deepEqual(environment,{});assert.equal(JSON.stringify(registry.metadata()).includes(secret),false);
 assert.equal((await registry.resolve("node"))?.secret,secret);registry.dispose();assert.equal(await registry.resolve("node"),null);
});

test("identity capture rejects duplicate ownership and non Railway public endpoints",()=>{
 const identity={binding:{nodeId:"node",generation:1,chatId:1,threadId:2,status:"ready"},endpoint:"https://owned.up.railway.app",secret:"a".repeat(64)};
 assert.throws(()=>captureNodeRegistry({CONTROL_NODE_REGISTRY:JSON.stringify([identity,{...identity,binding:{...identity.binding,nodeId:"other"}}])}),/Duplicate/);
 assert.throws(()=>captureNodeRegistry({CONTROL_NODE_REGISTRY:JSON.stringify([{...identity,endpoint:"http://127.0.0.1"}])}),/identity/);
});
