import { AsyncLocalStorage } from "node:async_hooks";
import type { GlobalMutationActor } from "./mutations.js";
import { getTopicRuntimeContext } from "../app/services/topic-runtime-context.js";
import { resolveCoreTopicBinding } from "../core/native-core-service.js";
import {nodeBindings} from "./node-bindings.js";

const authenticated = new AsyncLocalStorage<GlobalMutationActor>();

/** Internal transport entry point: call only after signature and binding verification. */
export function runWithAuthenticatedMutationActor<T>(actor: GlobalMutationActor, callback: () => T): T {
  return authenticated.run(Object.freeze({ ...actor }), callback);
}

/** Never accepts Topic identity from tool arguments. Missing trusted scope fails closed. */
export function getAuthenticatedMutationActor(sessionId: string): GlobalMutationActor | null {
  const remote = authenticated.getStore();
  if (remote) return remote.sessionId === sessionId ? { ...remote } : null;
  const context = getTopicRuntimeContext();
  if (!context || context.sessionId !== sessionId || context.threadId <= 0) return null;
  const binding = resolveCoreTopicBinding(context.chatId, context.threadId);
  if (!binding || binding.sessionId !== sessionId) return null;
  return { nodeId: `legacy:${binding.bindingId}`, generation: binding.bindingGeneration,
    chatId: context.chatId, threadId: context.threadId, sessionId };
}

/** Trusted Telegram event/callback scope resolves remote ownership from durable bindings. */
export async function resolveAuthenticatedMutationActor(sessionId:string):Promise<GlobalMutationActor|null>{
  const actor=authenticated.getStore();if(actor)return actor.sessionId===sessionId?{...actor}:null;
  const context=getTopicRuntimeContext();
  if(!context || context.sessionId!==sessionId || context.threadId<=1)return null;
  const remote=await nodeBindings.find(context.chatId,context.threadId);
  if(remote){
    if(remote.status!=="ready" || remote.sessionId!==sessionId)return null;
    return {nodeId:remote.nodeId,generation:remote.generation,chatId:remote.chatId,threadId:remote.threadId,sessionId};
  }
  return getAuthenticatedMutationActor(sessionId);
}
