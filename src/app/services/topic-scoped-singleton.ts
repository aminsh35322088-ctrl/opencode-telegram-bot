import { getTopicRuntimeContext } from "./topic-runtime-context.js";

const installedTargets = new WeakSet<object>();
const instances = new WeakMap<object, Map<string, object>>();

function topicKey(): string | null {
  const topic = getTopicRuntimeContext();
  return topic ? `${topic.chatId}:${topic.threadId}` : null;
}

export function installTopicScopedSingleton<T extends object>(target: T): T {
  if (installedTargets.has(target)) return target;
  installedTargets.add(target);
  const prototype = Object.getPrototypeOf(target) as object | null;
  if (!prototype) return target;
  const instanceMap = new Map<string, object>();
  instances.set(target, instanceMap);

  for (const methodName of Object.getOwnPropertyNames(prototype)) {
    if (methodName === "constructor") continue;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, methodName);
    if (!descriptor || typeof descriptor.value !== "function") continue;
    const original = descriptor.value as (...args: never[]) => unknown;
    Object.defineProperty(target, methodName, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: function scopedMethod(this: T, ...args: never[]) {
        const key = topicKey();
        if (!key) return original.apply(target, args);
        let instance = instanceMap.get(key) as T | undefined;
        if (!instance) {
          const Constructor = (target as T & { constructor: new () => T }).constructor;
          instance = new Constructor();
          instanceMap.set(key, instance);
        }
        return original.apply(instance, args);
      },
    });
  }
  return target;
}
