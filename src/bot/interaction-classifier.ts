import type { Context } from "grammy";
import { keyboardManager } from "./keyboards/keyboard-manager.js";
import { MAIN_BUTTONS, TOPIC_BUTTONS } from "./keyboards/main-reply-keyboard.js";
import { getStoredModel } from "../app/services/model-selection-service.js";
import { formatModelForButton } from "../app/types/model.js";
import { getTopicRuntimeContext } from "../app/services/topic-runtime-context.js";
import { findTelegramTopicBindingByThread } from "../app/services/telegram-topic-store.js";

export type ReplyKeyboardScope = "main" | "general" | "ai-topic";

export type ReplyKeyboardInteraction = {
  isControl: boolean;
  scope: ReplyKeyboardScope;
  text: string;
  controlId?: string;
};

function normalize(text: string): string {
  return text.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\uFE0F/g, "").replace(/\s+/g, " ").trim();
}

function keyboardButtonTexts(keyboard: unknown): string[] {
  if (!Array.isArray(keyboard)) return [];
  return keyboard.flatMap((row) => {
    if (!Array.isArray(row)) return [];
    return row.flatMap((button) => {
      if (typeof button === "string") return [button];
      if (typeof button === "object" && button !== null && "text" in button) {
        const value = Reflect.get(button, "text");
        return typeof value === "string" ? [value] : [];
      }
      return [];
    });
  });
}

function currentGlobalModelButton(): string {
  const model = getStoredModel();
  return model.providerID && model.modelID
    ? formatModelForButton(model.providerID, model.modelID, model.name)
    : "🧠 Model";
}

function staticControlMap(): ReadonlyMap<string, string> {
  return new Map<string, string>([
    [MAIN_BUTTONS.history, "history"],
    [MAIN_BUTTONS.newChat, "new-chat"],
    [MAIN_BUTTONS.mainSettings, "main-settings"],
    [MAIN_BUTTONS.topicSettings, "topic-settings"],
    [MAIN_BUTTONS.imageAi, "image-ai"],
    [MAIN_BUTTONS.deleteChat, "delete-chat"],
    [MAIN_BUTTONS.pause, "pause"],
    [MAIN_BUTTONS.resume, "resume"],
    [MAIN_BUTTONS.abort, "abort"],
    ["🧠 Model Center", "model-center"],
    ["❌ Cancel", "cancel"],
    [MAIN_BUTTONS.compact(true), "compact"],
    [MAIN_BUTTONS.compact(false), "compact"],
  ].map(([text, id]) => [normalize(text), id] as [string, string]));
}

async function resolveScope(ctx: Context): Promise<ReplyKeyboardScope> {
  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id;
  if (typeof chatId !== "number") return "main";
  if (typeof threadId !== "number" || threadId <= 1) {
    return keyboardManager.isTopicMode(chatId) ? "general" : "main";
  }

  const runtime = getTopicRuntimeContext();
  if (runtime?.chatId === chatId && runtime.threadId === threadId && runtime.sessionId) return "ai-topic";
  const binding = await findTelegramTopicBindingByThread(chatId, threadId);
  return binding ? "ai-topic" : "main";
}

function getRenderedLabels(scope: ReplyKeyboardScope, sessionId?: string): Set<string> {
  const keyboard = scope === "ai-topic"
    ? keyboardManager.getKeyboard(sessionId)
    : scope === "general"
      ? keyboardManager.getKeyboard()
      : null;
  const built = keyboard && typeof (keyboard as { build?: () => unknown }).build === "function"
    ? (keyboard as { build: () => unknown }).build()
    : keyboard;
  return new Set(keyboardButtonTexts(built).map(normalize));
}

/**
 * Single gate for Reply Keyboard text. A text is a control only when it is an
 * exact label rendered by the current keyboard or an exact stable control label.
 * Deliberately avoids broad emoji/regex matching so normal user prose cannot be
 * promoted to a control by its wording.
 */
export async function classifyReplyKeyboardInteraction(ctx: Context): Promise<ReplyKeyboardInteraction> {
  const raw = ctx.message?.text;
  const text = typeof raw === "string" ? normalize(raw) : "";
  const scope = await resolveScope(ctx);
  if (!text) return { isControl: false, scope, text };

  const runtime = getTopicRuntimeContext();
  const sessionId = scope === "ai-topic" ? runtime?.sessionId : undefined;
  const rendered = getRenderedLabels(scope, sessionId);
  const staticControls = staticControlMap();
  const controlId = staticControls.get(text);

  if (controlId) return { isControl: true, scope, text, controlId };
  if (rendered.has(text)) {
    if (text === normalize(TOPIC_BUTTONS.modelCenter(keyboardManager.getState(sessionId)?.currentModel))) {
      return { isControl: true, scope, text, controlId: "model" };
    }
    return { isControl: true, scope, text, controlId: "keyboard-control" };
  }

  const globalModel = normalize(currentGlobalModelButton());
  const topicModel = normalize(TOPIC_BUTTONS.modelCenter(keyboardManager.getState(sessionId)?.currentModel));
  if (text === globalModel || text === topicModel) return { isControl: true, scope, text, controlId: "model" };

  return { isControl: false, scope, text };
}

export async function isReplyKeyboardControl(ctx: Context): Promise<boolean> {
  return (await classifyReplyKeyboardInteraction(ctx)).isControl;
}
