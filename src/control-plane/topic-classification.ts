import path from 'node:path';
interface Binding {chatId:number;threadId:number;sessionId:string;directory:string}
interface SessionMetadata {id:string;directory:string;parentID?:string;time?:{archived?:number}}
export type TopicRole='writable-ai'|'control'|'read-only-inspector'|'stale-deleted'|'ambiguous-legacy';
/** Metadata inspection only: absent sessions do not prove Telegram deletion. */
export function classifyTopicBinding(binding:Binding,session?:SessionMetadata,deletionProven=false):{role:TopicRole;evidence:string}{
 if(binding.threadId<=1)return {role:'control',evidence:'general-thread'};
 if(deletionProven)return {role:'stale-deleted',evidence:'explicit-deletion-proof'};
 if(!session||session.id!==binding.sessionId||path.resolve(session.directory)!==path.resolve(binding.directory)||session.time?.archived)return {role:'ambiguous-legacy',evidence:'session-unverified-or-archived'};
 if(session.parentID)return {role:'read-only-inspector',evidence:'child-session'};
 return {role:'writable-ai',evidence:'verified-root-session'};
}
/** One bounded startup inspection. Never modifies bindings, sessions or workspaces. */
export async function inspectExistingTopicBindings():Promise<void>{
 const {listTelegramTopicBindings}=await import('../app/services/telegram-topic-store.js');
 const {opencodeClient}=await import('../opencode/client.js');
 const {logger}=await import('../utils/logger.js');
 const bindings=await listTelegramTopicBindings();
 let writable=0;
 for(const binding of bindings){
  let session:SessionMetadata|undefined;
  if(binding.threadId>1){try{const result=await opencodeClient.session.get({sessionID:binding.sessionId,directory:binding.directory},{signal:AbortSignal.timeout(5000)});if(!result.error)session=result.data;}catch{/* Preserve unverified bindings. */}}
  const classification=classifyTopicBinding(binding,session);
  if(classification.role==='writable-ai')writable++;
  logger.info(`[DistributedClassification] chat=${binding.chatId} thread=${binding.threadId} role=${classification.role} evidence=${classification.evidence}`);
 }
 logger.info(`[DistributedClassification] writable=${writable} maximum=4 migration=${writable>4?'selection-required':'canary-required'}`);
}
