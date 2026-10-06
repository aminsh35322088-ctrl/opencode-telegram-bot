import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runTrustedTelegramGlobalMutation} from '../src/control-plane/mutations.js';
import {createMcpServerFromInput,loadMcpServers,setMcpServerEnabled,renameMcpServer,deleteMcpServer,ensureMcpRuntimeForDirectory} from '../src/app/services/mcp-server-service.js';
import {listManagedMcpServers} from '../src/app/services/mcp-server-store.js';
import {listMcpTools,callMcpTool} from '../src/app/services/mcp-client-service.js';
test('distributed MCP desired state remains global without a local Core endpoint',async()=>{
 const home=await mkdtemp(path.join(tmpdir(),'control-mcp-'));process.env.OPENCODE_TELEGRAM_HOME=home;process.env.DISTRIBUTED_CONTROL_ENABLED='1';
 try {
  await assert.rejects(createMcpServerFromInput({projectDirectory:'/topic-a',name:'shared',type:'remote',value:'https://example.com/mcp'}),/approved Question/);
  const created=await runTrustedTelegramGlobalMutation('mcp.add','shared',()=>createMcpServerFromInput({projectDirectory:'/topic-a',name:'shared',type:'remote',value:'https://example.com/mcp'}));
  assert.equal(created.status.status,'failed');
  assert.equal((await loadMcpServers('/topic-b'))[0]?.name,'shared');
  await runTrustedTelegramGlobalMutation('mcp.enable','shared',()=>setMcpServerEnabled('/topic-b','shared',false));
  assert.equal((await listManagedMcpServers())[0]?.config.enabled,false);
  assert.equal((await loadMcpServers('/topic-a'))[0]?.status.status,'disabled');
  await runTrustedTelegramGlobalMutation('mcp.rename','shared',()=>renameMcpServer('/topic-b','shared','renamed'));
  assert.equal((await loadMcpServers('/topic-a'))[0]?.name,'renamed');
  assert.deepEqual(await ensureMcpRuntimeForDirectory('/topic-b'),{restored:0,failed:0});
  await assert.rejects(listMcpTools({type:'local',command:['does-not-exist']}),/Worker/);
  await assert.rejects(callMcpTool({type:'remote',url:'https://example.com/mcp'},'tool',{}),/Worker/);
  await runTrustedTelegramGlobalMutation('mcp.delete','renamed',()=>deleteMcpServer('/topic-b','renamed'));
  assert.deepEqual(await loadMcpServers('/topic-a'),[]);
 }finally{delete process.env.DISTRIBUTED_CONTROL_ENABLED;delete process.env.OPENCODE_TELEGRAM_HOME;await rm(home,{recursive:true,force:true});}
});
