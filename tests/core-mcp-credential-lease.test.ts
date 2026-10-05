import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {leaseMcpCredential} from '../src/control-plane/mcp-credential-lease.js';
const id=createHash('sha256').update('/canonical\0approved').digest('hex');
const server={projectDirectory:'/canonical',name:'approved',config:{type:'remote',url:'https://example.com/mcp',enabled:true}};
const state={mcpServers:{records:{[id]:server}},mcpCredentials:{records:{[id]:{ciphertext:'encrypted'}}}};
const payload={purpose:'mcp.request',capability:'mcp:approved',credentialId:id,endpoint:'https://example.com/mcp'};
let decryptions=0;
const dependencies={state:async()=>state,credential:async()=>{decryptions++;return {projectDirectory:'/canonical',serverName:'approved',remoteUrl:'https://example.com/mcp',mode:'bearer' as const,secret:'synthetic-key'};},now:()=>1000};
test('MCP lease authorizes exact enabled global server and returns bounded memory-only headers',async()=>{
 assert.deepEqual(await leaseMcpCredential(payload,dependencies),{headers:{Authorization:'Bearer synthetic-key'},expiresAt:61000});
});
test('MCP wrong endpoint/name/reference and disabled state fail before vault decryption',async()=>{
 decryptions=0;
 for(const mutation of [{endpoint:'https://other.example/mcp'},{capability:'mcp:other'},{credentialId:'other'},{purpose:'provider.request'}])await assert.rejects(leaseMcpCredential({...payload,...mutation},dependencies));
 await assert.rejects(leaseMcpCredential(payload,{...dependencies,state:async()=>({...state,mcpServers:{records:{[id]:{...server,config:{...server.config,enabled:false}}}}})}));
 assert.equal(decryptions,0);
});
test('credential endpoint mismatch, injection headers, and unsupported OAuth fail only capability',async()=>{
 for(const credential of [
 {mode:'bearer',secret:'synthetic-key',remoteUrl:'https://other.example/mcp'},
 {mode:'custom-header',secret:'synthetic-key',headerName:'Host'},
 {mode:'custom-header',secret:'key\r\nHost: evil',headerName:'X-Key'},
 {mode:'oauth-client',clientId:'synthetic'},
 ])await assert.rejects(leaseMcpCredential(payload,{...dependencies,credential:async()=>({...server,serverName:'approved',remoteUrl:server.config.url,...credential}) as never}));
});
