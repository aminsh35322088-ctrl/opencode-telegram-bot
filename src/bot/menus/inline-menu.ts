import { Context, InlineKeyboard } from "grammy";
import { interactionManager, DEFAULT_INLINE_MENU_TTL_MS } from "../../app/managers/interaction-manager.js";
import type { InteractionMetadata } from "../../app/types/interaction.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { buildMainStatusText } from "../keyboards/keyboard-manager.js";

export const INLINE_MENU_CANCEL_PREFIX = "inline:cancel:";
export const LEGACY_CONTEXT_CANCEL_CALLBACK = "compact:cancel";
export const INLINE_MENU_HOME_CALLBACK = "main:home";
export const INLINE_MENU_HOME_LABEL = "🏠 Home";
const INLINE_MENU_CLOSE_LABEL = "✖ Close";
const INLINE_MENU_BACK_LABEL = "← Back";
const INLINE_MENU_SETTINGS_BACK_CALLBACK = "settings:back";

const INLINE_MENU_KINDS = ["session", "model", "agent", "variant", "context", "open", "ls", "worktree", "settings"] as const;
export type InlineMenuKind = (typeof INLINE_MENU_KINDS)[number];
export type InlineMenuNavigation = "auto" | "close" | "back" | "both";

type CallbackNavigationButton = { text: string; callback_data: string };

interface ActiveInlineMenuMetadata { menuKind: InlineMenuKind; messageId: number; threadId?: number; }
interface InlineMenuReplyOptions { menuKind: InlineMenuKind; text: string; keyboard: InlineKeyboard; parseMode?: "Markdown" | "HTML"; metadata?: InteractionMetadata; navigation?: InlineMenuNavigation; }

const activeInlineMenus = new Map<string, ActiveInlineMenuMetadata>();

export function isInlineMenuKind(value: string): value is InlineMenuKind { return INLINE_MENU_KINDS.includes(value as InlineMenuKind); }
function getCallbackMessageId(ctx: Context): number | null { const message = ctx.callbackQuery?.message; if (!message || !("message_id" in message)) return null; const id = (message as { message_id?: number }).message_id; return typeof id === "number" ? id : null; }
function getChatId(ctx: Context): number | null { return typeof ctx.chat?.id === "number" ? ctx.chat.id : null; }
function getTopicThreadId(ctx: Context): number | null {
  const message = (ctx.message ?? ctx.callbackQuery?.message) as { message_thread_id?: number } | undefined;
  return typeof message?.message_thread_id === "number" ? message.message_thread_id : null;
}
function menuKey(chatId: number, threadId?: number): string { return `${chatId}:${threadId ?? 0}`; }
function isHomeButton(button: CallbackNavigationButton): boolean {
  return button.text === INLINE_MENU_HOME_LABEL && button.callback_data === INLINE_MENU_HOME_CALLBACK;
}
function isCloseButton(button: CallbackNavigationButton): boolean {
  return button.text === INLINE_MENU_CLOSE_LABEL || button.callback_data.startsWith(INLINE_MENU_CANCEL_PREFIX);
}
function isBackButton(button: CallbackNavigationButton): boolean {
  // Pagination arrows are not navigation Back buttons.
  if (button.callback_data.startsWith("session:page:")) return false;
  return button.text?.startsWith("←") || button.callback_data === INLINE_MENU_SETTINGS_BACK_CALLBACK || (button.callback_data.startsWith("mc:") && button.callback_data.includes("back"));
}
function trimEmptyKeyboardRows(keyboard: InlineKeyboard): void {
  while (keyboard.inline_keyboard.length > 0) {
    const lastRow = keyboard.inline_keyboard[keyboard.inline_keyboard.length - 1];
    if (!lastRow || lastRow.length > 0) break;
    keyboard.inline_keyboard.pop();
  }
}

/** Add Home beside every semantic Back button. Non-topic menus also get a fallback Home row. */
export function appendHomeNavigation(keyboard: InlineKeyboard, addFallbackHome = true): InlineKeyboard {
  trimEmptyKeyboardRows(keyboard);
  let hasHome = false;

  for (const row of keyboard.inline_keyboard) {
    let hasBack = false;
    let rowHasHome = false;
    for (const button of row) {
      if (!("callback_data" in button)) continue;
      const callbackButton = button as CallbackNavigationButton;
      if (isHomeButton(callbackButton)) {
        hasHome = true;
        rowHasHome = true;
      }
      if (isBackButton(callbackButton)) hasBack = true;
    }
    if (hasBack && !rowHasHome) {
      row.push({ text: INLINE_MENU_HOME_LABEL, callback_data: INLINE_MENU_HOME_CALLBACK });
      hasHome = true;
    }
  }

  if (!hasHome && addFallbackHome) keyboard.row().text(INLINE_MENU_HOME_LABEL, INLINE_MENU_HOME_CALLBACK);
  return keyboard;
}

export function appendInlineMenuCancelButton(keyboard: InlineKeyboard, menuKind: InlineMenuKind, threadId?: number, navigation: InlineMenuNavigation = "auto"): InlineKeyboard {
  trimEmptyKeyboardRows(keyboard);
  const isTopic = typeof threadId === "number" && threadId > 1;
  if (!isTopic) return appendHomeNavigation(keyboard);

  const mode: Exclude<InlineMenuNavigation, "auto"> = navigation === "auto"
    ? (menuKind === "settings" ? "close" : "back")
    : navigation;

  let backButton: CallbackNavigationButton | undefined;
  let hasClose = false;
  for (const row of keyboard.inline_keyboard) {
    for (const button of row) {
      if (!("callback_data" in button)) continue;
      const callbackButton = button as CallbackNavigationButton;
      if (!backButton && isBackButton(callbackButton)) backButton = callbackButton;
      if (isCloseButton(callbackButton)) hasClose = true;
    }
  }

  if (mode === "back" || mode === "both") {
    if (!backButton) {
      keyboard.row().text(INLINE_MENU_BACK_LABEL, INLINE_MENU_SETTINGS_BACK_CALLBACK);
    } else if (menuKind === "settings" && backButton.callback_data === INLINE_MENU_SETTINGS_BACK_CALLBACK) {
      // Topic child Settings uses one stable parent callback and a uniform Back label.
      backButton.text = INLINE_MENU_BACK_LABEL;
    }
  }
  if ((mode === "close" || mode === "both") && !hasClose) {
    keyboard.row().text(INLINE_MENU_CLOSE_LABEL, `${INLINE_MENU_CANCEL_PREFIX}${menuKind}`);
  }

  // Topic root Settings intentionally stays Close-only. Every actual Back row still gets Home.
  return appendHomeNavigation(keyboard, false);
}

export async function replyWithInlineMenu(ctx: Context, options: InlineMenuReplyOptions): Promise<number> {
  const threadId = getTopicThreadId(ctx);
  const keyboard = appendInlineMenuCancelButton(options.keyboard, options.menuKind, threadId ?? undefined, options.navigation);
  const replyOptions: { reply_markup: InlineKeyboard; parse_mode?: "Markdown" | "HTML" } = { reply_markup: keyboard };
  if (options.parseMode) replyOptions.parse_mode = options.parseMode;

  const chatId = getChatId(ctx);
  let messageId: number;
  const callbackMessageId = getCallbackMessageId(ctx);
  const callbackData = ctx.callbackQuery?.data ?? "";
  const preserveMainStatus = callbackMessageId !== null && callbackData.startsWith("main:");

  if (callbackMessageId !== null && chatId !== null) {
    try {
      const messageText = preserveMainStatus ? await buildMainStatusText() : options.text;
      await ctx.api.editMessageText(chatId, callbackMessageId, messageText, preserveMainStatus ? { reply_markup: keyboard, parse_mode: "HTML" } : replyOptions);
      messageId = callbackMessageId;
    } catch (error) {
      logger.debug("[InlineMenu] Could not edit callback message; falling back to reply", error);
      const message = await ctx.reply(options.text, {
        ...replyOptions,
        ...(threadId !== null ? { message_thread_id: threadId } : {}),
      } as never);
      messageId = message.message_id;
    }
  } else {
    const message = await ctx.reply(options.text, {
      ...replyOptions,
      ...(threadId !== null ? { message_thread_id: threadId } : {}),
    } as never);
    messageId = message.message_id;
  }

  if (chatId !== null) activeInlineMenus.set(menuKey(chatId, threadId ?? undefined), { menuKind: options.menuKind, messageId, ...(threadId !== null ? { threadId } : {}) });
  interactionManager.start({ kind: "inline", expectedInput: "callback", metadata: { ...options.metadata, menuKind: options.menuKind, messageId, ...(chatId !== null ? { chatId } : {}), ...(threadId !== null ? { threadId } : {}) } });
  logger.debug(`[InlineMenu] Opened/updated menu: kind=${options.menuKind}, messageId=${messageId}, chatId=${chatId ?? "none"}, threadId=${threadId ?? "main"}`);
  return messageId;
}

export async function ensureActiveInlineMenu(ctx: Context, menuKind: InlineMenuKind): Promise<boolean> {
  const chatId = getChatId(ctx);
  const threadId = getTopicThreadId(ctx);
  const activeMetadata = chatId !== null ? activeInlineMenus.get(menuKey(chatId, threadId ?? undefined)) ?? null : null;
  const callbackMessageId = getCallbackMessageId(ctx);
  const callbackData = ctx.callbackQuery?.data ?? "";
  const isActive = !!activeMetadata && callbackMessageId !== null && activeMetadata.menuKind === menuKind && activeMetadata.messageId === callbackMessageId;
  if (isActive) {
    interactionManager.transition({ expiresInMs: DEFAULT_INLINE_MENU_TTL_MS });
    return true;
  }

  if (chatId !== null && callbackMessageId !== null && (callbackData.startsWith(`${menuKind}:`) || callbackData.startsWith(`${INLINE_MENU_CANCEL_PREFIX}${menuKind}`))) {
    activeInlineMenus.set(menuKey(chatId, threadId ?? undefined), { menuKind, messageId: callbackMessageId, ...(threadId !== null ? { threadId } : {}) });
    logger.debug(`[InlineMenu] Rehydrated menu from callback: kind=${menuKind}, messageId=${callbackMessageId}, chatId=${chatId}, threadId=${threadId ?? "main"}`);
    return true;
  }

  logger.debug(`[InlineMenu] Stale callback ignored: expectedKind=${menuKind}, callbackMessageId=${callbackMessageId || "none"}, chatId=${chatId ?? "none"}, threadId=${threadId ?? "main"}`);
  await ctx.answerCallbackQuery({ text: t("inline.inactive_callback"), show_alert: true }).catch(() => {});
  return false;
}

export async function closeActiveInlineMenu(ctx: Context, reason = "navigation"): Promise<void> {
  const chatId = getChatId(ctx);
  const threadId = getTopicThreadId(ctx);
  const active = chatId !== null ? activeInlineMenus.get(menuKey(chatId, threadId ?? undefined)) ?? null : null;
  if (!active || !ctx.chat?.id) { clearActiveInlineMenu(reason, chatId ?? undefined, threadId ?? undefined); return; }
  await ctx.api.deleteMessage(ctx.chat.id, active.messageId).catch(() => {});
  clearActiveInlineMenu(reason, chatId ?? undefined, threadId ?? undefined);
}

export function clearActiveInlineMenu(reason: string, chatId?: number, threadId?: number): void {
  if (typeof chatId === "number") {
    activeInlineMenus.delete(menuKey(chatId, threadId));
    if (threadId === undefined) {
      for (const key of activeInlineMenus.keys()) if (key.startsWith(`${chatId}:`)) activeInlineMenus.delete(key);
    }
  } else activeInlineMenus.clear();
  const state = interactionManager.getSnapshot();
  if (state?.kind !== "inline") return;
  const stateChatId = state.metadata.chatId; const stateThreadId = state.metadata.threadId;
  if (typeof chatId === "number" && typeof stateChatId === "number" && stateChatId !== chatId) return;
  if (typeof threadId === "number" && typeof stateThreadId === "number" && stateThreadId !== threadId) return;
  interactionManager.clear(reason);
}
