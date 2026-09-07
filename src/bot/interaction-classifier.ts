import type { Context } from "grammy";
import { keyboardManager } from "./keyboards/keyboard-manager.js";
import { MAIN_BUTTONS } from "./keyboards/main-reply-keyboard.js";
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
  const controls = new Map<string, string>();
  const add = (text: string, id: string): void => { controls.set(normalize(text), id); };
  add(MAIN_BUTTONS.history, "history");
  add(MAIN_BUTTONS.newChat, "new-chat");
  add(MAIN_BUTTONS.mainSettings, "main-settings");
  add(MAIN_BUTTONS.topicSettings, "topic-settings");
  add(MAIN_BUTTONS.imageAi, "image-ai");
  add(MAIN_BUTTONS.deleteChat, "delete-chat");
  add(MAIN_BUTTONS.pause, "pause");
  add(MAIN_BUTTONS.resume, "resume");
  add(MAIN_BUTTONS.abort, "abort");
  add("🧠 Model Center", "model-center");
  add("❌ Cancel", "cancel");
  add(MAIN_BUTTONS.compact(true), "compact");
  add(MAIN_BUTTONS.compact(false), "compact");
  return controls;
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
 * Authoritative boundary between Reply Keyboard controls and user prompts.
 * Controls are recognized only by exact labels rendered for the current scope,
 * plus stable labels that can legitimately arrive from a stale Telegram client.
 * No broad emoji/regex heuristic is used here.
 */
export async function classifyReplyKeyboardInteraction(ctx: Context): Promise<ReplyKeyboardInteraction> {
  const raw = ctx.message?.text;
  const text = typeof raw === "string" ? normalize(raw) : "";
  const scope = await resolveScope(ctx);
  if (!text) return { isControl: false, scope, text };

  const runtime = getTopicRuntimeContext();
  const sessionId = scope === "ai-topic" ? runtime?.sessionId : undefined;
  const rendered = getRenderedLabels(scope, sessionId);
  const controlId = staticControlMap().get(text);

  if (controlId) return { isControl: true, scope, text, controlId };
  if (rendered.has(text)) return { isControl: true, scope, text, controlId: "keyboard-control" };

  if (text === normalize(currentGlobalModelButton())) {
    return { isControl: true, scope, text, controlId: "model" };
  }

  return { isControl: false, scope, text };
}

export async function isReplyKeyboardControl(ctx: Context): Promise<boolean> {
  return (await classifyReplyKeyboardInteraction(ctx)).isControl;
}
