import type { Bot, Context } from "grammy";
import type { Api } from "grammy";
import { getTopicRuntimeContext } from "../../app/services/topic-runtime-context.js";
import { installTopicScopedSingleton } from "../../app/services/topic-scoped-singleton.js";
import { summaryAggregator } from "../../app/managers/summary-aggregation-manager.js";

installTopicScopedSingleton(summaryAggregator);

export interface TelegramTopicContext { chatId: number; threadId: number; }
export interface TelegramTopicRuntimeDependencies { ensureEventSubscription: (directory: string) => Promise<void>; }
let runtimeDependencies: TelegramTopicRuntimeDependencies | null = null;
export function setActiveTelegramTopic(_context: TelegramTopicContext | null): void {}
export function getActiveTelegramTopic(chatId?: number): TelegramTopicContext | null { const topic = getTopicRuntimeContext(); if (!topic) return null; if (chatId !== undefined && topic.chatId !== chatId) return null; return { chatId: topic.chatId, threadId: topic.threadId }; }
export function setTelegramTopicRuntimeDependencies(dependencies: TelegramTopicRuntimeDependencies): void { runtimeDependencies = dependencies; }
export function getTelegramTopicRuntimeDependencies(): TelegramTopicRuntimeDependencies | null { return runtimeDependencies; }
const TOPIC_SEND_METHODS = new Set(["sendMessage", "sendMessageDraft", "sendRichMessage", "sendRichMessageDraft", "sendPhoto", "sendVideo", "sendAnimation", "sendAudio", "sendDocument", "sendPaidMedia", "sendSticker", "sendVideoNote", "sendVoice", "sendLocation", "sendVenue", "sendContact", "sendPoll", "sendDice", "sendInvoice", "sendGame", "sendMediaGroup", "sendChatAction"]);
type ApiLike = Api;
function isOptionsObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function addThreadToArgs(args: unknown[], threadId: number): unknown[] { const patched = [...args]; for (let index = patched.length - 1; index >= 0; index -= 1) { if (!isOptionsObject(patched[index])) continue; const options = patched[index] as Record<string, unknown>; if (typeof options.message_thread_id === "number") return patched; patched[index] = { ...options, message_thread_id: threadId }; return patched; } patched.push({ message_thread_id: threadId }); return patched; }
function createTopicAwareApi(api: ApiLike, explicitTopic?: TelegramTopicContext): ApiLike { return new Proxy(api, { get(target, property, receiver) { const value = Reflect.get(target, property, receiver); if (typeof value !== "function") return value; const methodName = String(property); if (!TOPIC_SEND_METHODS.has(methodName)) return value.bind(target); return (...args: unknown[]) => { const runtimeContext = getTopicRuntimeContext(); const topic = explicitTopic ?? (runtimeContext ? { chatId: runtimeContext.chatId, threadId: runtimeContext.threadId } : null); if (!topic) return value.apply(target, args); const chatId = typeof args[0] === "number" ? args[0] : undefined; if (chatId !== undefined && chatId !== topic.chatId) return value.apply(target, args); return value.apply(target, addThreadToArgs(args, topic.threadId)); }; } }); }
const dynamicallyScopedBots = new WeakSet<object>();
function installDynamicTopicApi(bot: Bot<Context>): ApiLike {
  if (dynamicallyScopedBots.has(bot)) return bot.api;
  const dynamicApi = createTopicAwareApi(bot.api);
  Object.defineProperty(bot, "api", { value: dynamicApi, configurable: true });
  dynamicallyScopedBots.add(bot);
  return dynamicApi;
}
export function createTopicAwareBot(bot: Bot<Context>, explicitTopic?: TelegramTopicContext): Bot<Context> { const baseApi = installDynamicTopicApi(bot); const topicAwareApi = explicitTopic ? createTopicAwareApi(baseApi, explicitTopic) : baseApi; return new Proxy(bot, { get(target, property, receiver) { if (property === "api") return topicAwareApi; return Reflect.get(target, property, receiver); } }); }
