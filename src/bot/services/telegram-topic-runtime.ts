import type { Bot, Context } from "grammy";
import type { Api } from "grammy";
import { getTopicRuntimeContext } from "../../app/services/topic-runtime-context.js";
import { installTopicScopedSingleton } from "../../app/services/topic-scoped-singleton.js";
import { summaryAggregator } from "../../app/managers/summary-aggregation-manager.js";

installTopicScopedSingleton(summaryAggregator);

export interface TelegramTopicContext { chatId: number; threadId: number; }
export interface TelegramTopicRuntimeDependencies { ensureEventSubscription: (directory: string) => Promise<void>; retireSessionRuntime: (sessionId: string, reason: string) => void; }
let runtimeDependencies: TelegramTopicRuntimeDependencies | null = null;
export function setTelegramTopicRuntimeDependencies(dependencies: TelegramTopicRuntimeDependencies): void { runtimeDependencies = dependencies; }
export function getTelegramTopicRuntimeDependencies(): TelegramTopicRuntimeDependencies | null { return runtimeDependencies; }
const TOPIC_SEND_OPTIONS_INDEX: Readonly<Record<string, number>> = {
  sendMessage: 2, sendMessageDraft: 3, sendRichMessage: 2, sendRichMessageDraft: 3,
  sendPhoto: 2, sendVideo: 2, sendAnimation: 2, sendAudio: 2, sendDocument: 2,
  sendPaidMedia: 3, sendSticker: 2, sendVideoNote: 2, sendVoice: 2,
  sendLocation: 3, sendVenue: 5, sendContact: 3, sendPoll: 3, sendDice: 2,
  sendInvoice: 6, sendGame: 2, sendMediaGroup: 2, sendChatAction: 2,
};
type ApiLike = Api;
function isOptionsObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function addThreadToArgs(args: unknown[], optionsIndex: number, threadId: number): unknown[] {
  if (threadId <= 1) return args;
  const patched = [...args];
  const options = isOptionsObject(patched[optionsIndex]) ? patched[optionsIndex] : {};
  if (typeof options.message_thread_id === "number") return patched;
  patched[optionsIndex] = { ...options, message_thread_id: threadId };
  return patched;
}

// Topic-aware API proxies are convenient for session output, but they must never
// leak into chat-global UI managers. Keep a reversible chain so callers that own
// global navigation can always recover the original grammY API instance.
const topicAwareApiParents = new WeakMap<object, ApiLike>();
export function getUnscopedTelegramApi(api: ApiLike): ApiLike {
  let current = api;
  const seen = new Set<object>();
  while (typeof current === "object" && current !== null && topicAwareApiParents.has(current as object)) {
    if (seen.has(current as object)) break;
    seen.add(current as object);
    current = topicAwareApiParents.get(current as object)!;
  }
  return current;
}

export function createTopicAwareApi(api: ApiLike, explicitTopic?: TelegramTopicContext): ApiLike {
  const proxy = new Proxy(api, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      const methodName = String(property);
      const optionsIndex = TOPIC_SEND_OPTIONS_INDEX[methodName];
      if (optionsIndex === undefined) return value.bind(target);
      return (...args: unknown[]) => {
        const runtimeContext = getTopicRuntimeContext();
        const topic = explicitTopic ?? (runtimeContext ? { chatId: runtimeContext.chatId, threadId: runtimeContext.threadId } : null);
        if (!topic) return value.apply(target, args);
        const chatId = typeof args[0] === "number" ? args[0] : undefined;
        if (chatId !== undefined && chatId !== topic.chatId) return value.apply(target, args);
        return value.apply(target, addThreadToArgs(args, optionsIndex, topic.threadId));
      };
    },
  }) as ApiLike;
  topicAwareApiParents.set(proxy as object, api);
  return proxy;
}
const dynamicallyScopedBots = new WeakSet<object>();
function installDynamicTopicApi(bot: Bot<Context>): ApiLike {
  if (dynamicallyScopedBots.has(bot)) return bot.api;
  const dynamicApi = createTopicAwareApi(bot.api);
  Object.defineProperty(bot, "api", { value: dynamicApi, configurable: true });
  dynamicallyScopedBots.add(bot);
  return dynamicApi;
}
export function createTopicAwareBot(bot: Bot<Context>, explicitTopic?: TelegramTopicContext): Bot<Context> {
  const baseApi = installDynamicTopicApi(bot);
  const topicAwareApi = explicitTopic ? createTopicAwareApi(baseApi, explicitTopic) : baseApi;
  return new Proxy(bot, {
    get(target, property, receiver) {
      if (property === "api") return topicAwareApi;
      return Reflect.get(target, property, receiver);
    },
  });
}
