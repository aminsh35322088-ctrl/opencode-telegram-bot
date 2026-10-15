import type { Api } from "grammy";
import { assertCurrentRemoteCoreBinding, getNativeCore, isCurrentCoreSessionRoute, resolveCoreSessionRoute } from "../../core/native-core-service.js";
import { nodeBindings } from "../../control-plane/node-bindings.js";
import { listTelegramTopicBindings } from "../../app/services/telegram-topic-store.js";
import { createTopicAwareApi, getUnscopedTelegramApi } from "./telegram-topic-runtime.js";

export interface SessionTopicRoute {
  chatId: number;
  threadId: number;
  directory: string;
}

async function resolveRemoteSessionRoute(sessionId: string): Promise<SessionTopicRoute & {nodeId:string;generation:number}> {
  const matches = (await listTelegramTopicBindings()).filter((binding) => binding.sessionId === sessionId);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one remote Topic binding for session ${sessionId}; found ${matches.length}`);
  }
  const topic = matches[0]!;
  const worker = await nodeBindings.find(topic.chatId, topic.threadId);
  if (!worker || worker.status !== "ready" || worker.sessionId !== sessionId) {
    throw new Error(`Remote Worker does not own ready session ${sessionId}`);
  }
  return {chatId:topic.chatId,threadId:topic.threadId,directory:topic.directory,nodeId:worker.nodeId,generation:worker.generation};
}

/** Confirm that a session still belongs to the expected current local Core or remote Worker Topic. */
export async function assertCurrentSessionTopicRoute(sessionId:string, expected:SessionTopicRoute):Promise<void> {
  if(getNativeCore()) {
    const route=resolveCoreSessionRoute(sessionId,expected.directory);
    if(route.chatId!==expected.chatId||route.threadId!==expected.threadId||!isCurrentCoreSessionRoute(route))throw new Error("Core Topic session route changed");
    return;
  }
  const route=await resolveRemoteSessionRoute(sessionId);
  if(route.chatId!==expected.chatId||route.threadId!==expected.threadId||route.directory!==expected.directory)throw new Error("Remote Topic session route changed");
}

/** Bind asynchronous Telegram output to the exact current Topic generation. */
export function createCoreSessionApi(api: Api, sessionId: string): Api {
  if (!getNativeCore() && process.env.CONTROL_APPLICATION_IPC === "1") return createRemoteSessionApi(api,sessionId);
  try {
    const route = resolveCoreSessionRoute(sessionId);
    const scoped = createTopicAwareApi(getUnscopedTelegramApi(api), {
      chatId: route.chatId,
      threadId: route.threadId,
    });
    return new Proxy(scoped, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if(property==="raw"&&value&&typeof value==="object")return new Proxy(value,{
          get(raw,method,rawReceiver){
            const operation:unknown=Reflect.get(raw,method,rawReceiver);
            if(typeof operation!=="function")return operation;
            return (...args:unknown[])=>{
              if(!isCurrentCoreSessionRoute(route))throw new Error(`Core Topic binding changed before Telegram output: ${route.bindingId}`);
              const payload=args[0];
              if(payload&&typeof payload==="object"){
                const input=payload as Record<string,unknown>;
                if(input.chat_id!==undefined&&input.chat_id!==route.chatId)throw new Error("Raw Telegram output chat differs from Core Topic binding");
                if(input.message_thread_id!==undefined&&input.message_thread_id!==route.threadId)throw new Error("Raw Telegram output thread differs from Core Topic binding");
                if(typeof method==="string"&&method.startsWith("send")&&input.chat_id===route.chatId)args[0]={...input,message_thread_id:route.threadId};
              }
              return Reflect.apply(operation,raw,args);
            };
          },
        });
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (!isCurrentCoreSessionRoute(route)) {
            throw new Error(`Core Topic binding changed before Telegram output: ${route.bindingId}`);
          }
          if (typeof args[0] === "number" && args[0] !== route.chatId) {
            throw new Error(`Telegram output chat differs from Core Topic binding: ${route.bindingId}`);
          }
          const options = args.find((arg): arg is { message_thread_id: number } =>
            typeof arg === "object" && arg !== null && "message_thread_id" in arg &&
            typeof (arg as { message_thread_id?: unknown }).message_thread_id === "number"
          );
          if (options && options.message_thread_id !== route.threadId) {
            throw new Error(`Telegram output thread differs from Core Topic binding: ${route.bindingId}`);
          }
          return Reflect.apply(value, target, args);
        };
      },
    });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("OpenCode Telegram Core is not initialized")) throw error;
    return createRemoteSessionApi(api,sessionId);
  }
}

function createRemoteSessionApi(api:Api,sessionId:string):Api {
  const base=getUnscopedTelegramApi(api);
  // Capture route identity now; an old sender must never acquire a replacement Worker.
  let capturedBinding: ReturnType<typeof resolveCoreSessionRoute> | null = null;
  try { capturedBinding = resolveCoreSessionRoute(sessionId); } catch { /* Legacy remote-only route below. */ }
  const initial = resolveRemoteSessionRoute(sessionId);
  void initial.catch(() => {});
  const resolveCaptured = async () => {
    if (capturedBinding && !isCurrentCoreSessionRoute(capturedBinding)) throw new Error("Remote Topic binding changed before Telegram output");
    if (capturedBinding) await assertCurrentRemoteCoreBinding(capturedBinding);
    const expected = await initial;
    const current = await resolveRemoteSessionRoute(sessionId);
    if (current.nodeId !== expected.nodeId || current.generation !== expected.generation || current.chatId !== expected.chatId || current.threadId !== expected.threadId || current.directory !== expected.directory) throw new Error("Remote Worker changed before Telegram output");
    return current;
  };
  return new Proxy(base,{
    get(target,property,receiver){
      const value:unknown=Reflect.get(target,property,receiver);
      if(property==="raw"&&value&&typeof value==="object")return new Proxy(value,{
        get(raw,method,rawReceiver){
          const operation:unknown=Reflect.get(raw,method,rawReceiver);
          if(typeof operation!=="function")return operation;
          return async(...args:unknown[])=>{
            const route=await resolveCaptured();
            const payload=args[0];
            if(!payload||typeof payload!=="object")throw new Error("Raw remote Telegram output lacks a Topic payload");
            const input=payload as Record<string,unknown>;
            if(input.chat_id!==route.chatId)throw new Error("Raw Telegram output chat differs from remote Topic binding");
            if(input.message_thread_id!==undefined&&input.message_thread_id!==route.threadId)throw new Error("Raw Telegram output thread differs from remote Topic binding");
            if(typeof method==="string"&&method.startsWith("send"))args[0]={...input,message_thread_id:route.threadId};
            const current=await resolveCaptured();
            if(current.nodeId!==route.nodeId||current.generation!==route.generation||current.threadId!==route.threadId)throw new Error("Remote Topic binding changed before Telegram output");
            return Reflect.apply(operation,raw,args);
          };
        },
      });
      if(typeof value!=="function")return value;
      return async(...args:unknown[])=>{
        const route=await resolveCaptured();
        if(typeof args[0]==="number"&&args[0]!==route.chatId)throw new Error("Telegram output chat differs from remote Topic binding");
        const options=args.find((arg):arg is {message_thread_id:number}=>typeof arg==="object"&&arg!==null&&"message_thread_id" in arg&&typeof (arg as {message_thread_id?:unknown}).message_thread_id==="number");
        if(options&&options.message_thread_id!==route.threadId)throw new Error("Telegram output thread differs from remote Topic binding");
        const current=await resolveCaptured();
        if(current.nodeId!==route.nodeId||current.generation!==route.generation||current.threadId!==route.threadId)throw new Error("Remote Topic binding changed before Telegram output");
        const scoped=createTopicAwareApi(base,{chatId:route.chatId,threadId:route.threadId});
        const scopedMethod=Reflect.get(scoped,property,scoped);
        return Reflect.apply(scopedMethod,scoped,args);
      };
    },
  });
}
