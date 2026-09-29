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
