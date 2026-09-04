import type { Bot, Context } from "grammy";
import type { Api } from "grammy";

export interface TelegramTopicContext {
  chatId: number;
  threadId: number;
}

export interface TelegramTopicRuntimeDependencies {
  ensureEventSubscription: (directory: string) => Promise<void>;
}

let activeTopic: TelegramTopicContext | null = null;
let runtimeDependencies: TelegramTopicRuntimeDependencies | null = null;

export function setActiveTelegramTopic(context: TelegramTopicContext | null): void {
  activeTopic = context;
}

export function getActiveTelegramTopic(chatId?: number): TelegramTopicContext | null {
  if (!activeTopic) return null;
  if (chatId !== undefined && activeTopic.chatId !== chatId) return null;
  return activeTopic;
}

export function setTelegramTopicRuntimeDependencies(
  dependencies: TelegramTopicRuntimeDependencies,
): void {
  runtimeDependencies = dependencies;
}

export function getTelegramTopicRuntimeDependencies(): TelegramTopicRuntimeDependencies | null {
  return runtimeDependencies;
}

const TOPIC_SEND_METHODS = new Set([
  "sendMessage",
  "sendMessageDraft",
  "sendRichMessage",
  "sendRichMessageDraft",
  "sendPhoto",
  "sendVideo",
  "sendAnimation",
  "sendAudio",
  "sendDocument",
  "sendPaidMedia",
  "sendSticker",
  "sendVideoNote",
  "sendVoice",
  "sendLocation",
  "sendVenue",
  "sendContact",
  "sendPoll",
  "sendDice",
  "sendInvoice",
  "sendGame",
  "sendMediaGroup",
  "sendChatAction",
]);

type ApiLike = Api;

function isOptionsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addThreadToArgs(args: unknown[], threadId: number): unknown[] {
  const patched = [...args];

  for (let index = patched.length - 1; index >= 0; index -= 1) {
    if (!isOptionsObject(patched[index])) continue;
    const options = patched[index] as Record<string, unknown>;
    if (typeof options.message_thread_id === "number") return patched;
    patched[index] = { ...options, message_thread_id: threadId };
    return patched;
  }

  patched.push({ message_thread_id: threadId });
  return patched;
}

function createTopicAwareApi(api: ApiLike, topic?: TelegramTopicContext): ApiLike {
  return new Proxy(api, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;

      const methodName = String(property);
      if (!TOPIC_SEND_METHODS.has(methodName)) {
        return value.bind(target);
      }

      return (...args: unknown[]) => {
        // Explicit topic bindings are immutable. The shared event bot also
        // supports the currently active Topic for the legacy single-foreground
        // runtime path used by incoming Topic prompts.
        const resolvedTopic = topic ?? activeTopic;
        if (!resolvedTopic) {
          return value.apply(target, args);
        }

        const chatId = typeof args[0] === "number" ? args[0] : undefined;
        if (chatId !== undefined && chatId !== resolvedTopic.chatId) {
          return value.apply(target, args);
        }

        return value.apply(target, addThreadToArgs(args, resolvedTopic.threadId));
      };
    },
  });
}

/**
 * Event subscriptions receive a bot bound to one immutable Telegram Topic.
 * When no explicit binding is supplied, the shared event bot follows the
 * active foreground Topic set by session creation/selection.
 */
export function createTopicAwareBot(
  bot: Bot<Context>,
  topic?: TelegramTopicContext,
): Bot<Context> {
  const topicAwareApi = createTopicAwareApi(bot.api, topic);
  return new Proxy(bot, {
    get(target, property, receiver) {
      if (property === "api") return topicAwareApi;
      return Reflect.get(target, property, receiver);
    },
  });
}
