import assert from 'node:assert/strict';
import {test} from 'node:test';
import {classifyTopicBinding} from '../src/control-plane/topic-classification.js';
const binding={chatId:1802392273,threadId:42,sessionId:'session',directory:'/data/topic'};
test('only verified root sessions count as writable AI Topics',()=>{
 assert.equal(classifyTopicBinding(binding,{id:'session',directory:'/data/topic'}).role,'writable-ai');
 assert.equal(classifyTopicBinding(binding,{id:'session',directory:'/data/topic',parentID:'parent'}).role,'read-only-inspector');
 assert.equal(classifyTopicBinding({...binding,threadId:1}).role,'control');
});
test('missing, mismatched and archived legacy sessions remain preserved and ambiguous',()=>{
 for(const session of [undefined,{id:'different',directory:'/data/topic'},{id:'session',directory:'/other'},{id:'session',directory:'/data/topic',time:{archived:1}}])assert.equal(classifyTopicBinding(binding,session).role,'ambiguous-legacy');
 assert.equal(classifyTopicBinding(binding,undefined,true).role,'stale-deleted');
});
