import type { Api } from "grammy";
import { isCurrentCoreSessionRoute, resolveCoreSessionRoute } from "../../core/native-core-service.js";
import { createTopicAwareApi, getUnscopedTelegramApi } from "./telegram-topic-runtime.js";

/** Bind asynchronous Telegram output to the exact Core binding generation. */
export function createCoreSessionApi(api: Api, sessionId: string): Api {
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
}
