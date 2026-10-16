import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Api} from 'grammy';

process.env.OPENCODE_TELEGRAM_HOME=await mkdtemp(path.join(tmpdir(),'strict-new-chat-'));
const {nodeBindings}=await import('../src/control-plane/node-bindings.js');
const {TopicNodeLifecycle,topicNodeLifecycle,createRemoteTopicSession}=await import('../src/control-plane/topic-node-lifecycle.js');

test('New Chat verifies live capacity then binds exactly that Worker and confirms its session',async t=>{
 const events:string[]=[];
 let time=0;
 const slot=(await nodeBindings.ensurePoolSlots(1))[0]!;
 await nodeBindings.update(slot.nodeId,slot.generation,{status:'available',projectId:'p',serviceId:'s',volumeId:'v',endpoint:'https://worker.up.railway.app'});
 const lifecycle=new TopicNodeLifecycle({bindings:nodeBindings,now:()=>time,wait:async ms=>{time+=ms;},snapshot:async()=>({revision:1,hash:'h'}),
  infrastructure:async(operation,nodeId,generation)=>{
   events.push(operation);
   assert.equal(nodeId,slot.nodeId);
   return {nodeId,generation,projectId:'p',environmentId:'e',serviceId:'s',volumeId:'v',endpoint:'https://worker.up.railway.app',phase:operation==='rebind'?'recycled':'deploying'};
  },
  node:async(binding,operation)=>{
   events.push(operation);
   if(operation==='health')return {ok:true,result:{ready:true,readiness:binding.chatId===0?'ready-unbound':'ready'}};
   if(operation==='sync-global')return {ok:true,result:{revision:1,hash:'h'}};
   if(operation==='session.create')return {ok:true,result:{sessionId:'owned-session'}};
   if(operation==='session.get')return {ok:true,result:{id:'owned-session',title:'Owned',directory:'/data/topic'}};
   throw new Error('Unexpected operation');
  }});
 t.mock.method(topicNodeLifecycle,'verifyAvailableWorker',()=>lifecycle.verifyAvailableWorker());
 t.mock.method(topicNodeLifecycle,'ensureReady',(chat,thread,directory,prepared)=>lifecycle.ensureReady(chat,thread,directory,prepared));
 const api={raw:{createForumTopic:async()=>{events.push('telegram.create');return {message_thread_id:42};}}} as unknown as Api;
 const first=await createRemoteTopicSession(api,-800,'/topic','request-one');
 assert.equal(first.reused,false);assert.equal(first.binding.sessionId,'owned-session');
 const binding=await nodeBindings.find(-800,42);
 assert.equal(binding?.nodeId,slot.nodeId);assert.equal(binding?.generation,2);assert.equal(binding?.status,'ready');
 assert.ok(events.indexOf('inspect')<events.indexOf('telegram.create'));
 assert.ok(events.indexOf('telegram.create')<events.indexOf('rebind'));
 assert.ok(events.indexOf('rebind')<events.indexOf('session.create'));
 assert.equal(events.at(-1),'reconcile');
 const count=events.length;
 assert.equal((await createRemoteTopicSession(api,-800,'/other-workspace','request-one')).reused,true);
 assert.equal(events.length,count,'Completed retry must not create, rebind, or execute');
});

test('New Chat after capacity is claimed creates no extra Topic or Worker',async()=>{
 let creates=0;
 const api={raw:{createForumTopic:async()=>{creates++;return {message_thread_id:43};}}} as unknown as Api;
 await assert.rejects(createRemoteTopicSession(api,-801,'/topic-two','request-two'),/CAPACITY EXHAUSTED/);
 assert.equal(creates,0);assert.equal((await nodeBindings.list()).length,1);
});
