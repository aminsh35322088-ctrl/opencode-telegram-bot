import { PRICE_LEGEND } from "../../app/services/model-price-classifier.js";
import { getFreeModelDetectionEnabled } from "../../app/stores/settings-store.js";
import { PriceViewExpiredError, resolvePriceViewProvider } from "../menus/provider-price-view.js";
import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import {
  buildModelCenterList,
  buildModelCenterProvider,
  buildModelCenterProviders,
  buildModelCenterRoot,
  buildModelCenterSearchResults,
  MODEL_CENTER_FAVORITE_PREFIX,
  MODEL_CENTER_FAVORITES,
  MODEL_CENTER_PROVIDERS,
  MODEL_CENTER_PROVIDER_PREFIX,
  MODEL_CENTER_RECENT,
  MODEL_CENTER_ROOT,
  MODEL_CENTER_PRICE_LEGEND,
  MODEL_CENTER_PRICE_PAGE_PREFIX,
  MODEL_CENTER_SEARCH,
  MODEL_CENTER_SEARCH_AGAIN,
  MODEL_CENTER_SEARCH_CANCEL,
  MODEL_CENTER_SELECT_PREFIX,
  resolveModelCenterAction,
  resolveModelCenterFavoriteTarget,
  type ModelCenterFavoriteTarget,
} from "../menus/model-center-menu.js";
import { fetchCurrentModel, getProviders, isSelectableChatModel, selectModel } from "../../app/services/model-selection-service.js";
import { recordRecentModel, toggleFavoriteModel } from "../../app/services/model-preferences-service.js";
import { formatVariantForButton } from "../../app/services/variant-selection-service.js";
import { formatModelForDisplay, type ModelInfo } from "../../app/types/model.js";
import { resolveProjectAgent, getStoredAgent } from "../../app/services/agent-selection-service.js";
import { createMainKeyboard } from "../keyboards/main-reply-keyboard.js";
import { keyboardManager } from "../keyboards/keyboard-manager.js";
import { pinnedMessageManager } from "../pinned/pinned-message-manager.js";
import { switched } from "./feedback.js";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import { getModelCapabilities, formatCapabilitiesIcons } from "../../app/services/model-capabilities-service.js";
import { getCurrentSession } from "../../app/services/session-service.js";
import { logger } from "../../utils/logger.js";
import { getCurrentTopicSettings, updateTopicDefaults } from "../../app/stores/settings-store.js";
import { findTelegramTopicBindingByThread } from "../../app/services/telegram-topic-store.js";

const SEARCH_FLOW = "model-search";
interface ModelCenterSearchState { stage: "input" | "results"; }
function getTopicThreadId(ctx: Context): number | undefined { const message = ctx.callbackQuery?.message; const threadId = message && "message_thread_id" in message ? (message as { message_thread_id?: number }).message_thread_id : undefined; return typeof threadId === "number" ? threadId : undefined; }
function getMessageThreadId(ctx: Context): number | undefined { const message = ctx.message; const threadId = message && "message_thread_id" in message ? (message as { message_thread_id?: number }).message_thread_id : undefined; return typeof threadId === "number" ? threadId : undefined; }
function getCallbackMessageId(ctx: Context): number | null { const message = ctx.callbackQuery?.message; return message && "message_id" in message && typeof message.message_id === "number" ? message.message_id : null; }
function searchInputKeyboard(): InlineKeyboard { return new InlineKeyboard().text("← Back", MODEL_CENTER_ROOT).text("🏠 Home", "main:home"); }
async function deleteSearchInput(ctx: Context): Promise<void> { if (ctx.chat?.id && ctx.message?.message_id) await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {}); }
async function editSearchPanel(ctx: Context, messageId: number, text: string, keyboard: InlineKeyboard): Promise<void> { if (!ctx.chat?.id) return; await ctx.api.editMessageText(ctx.chat.id, messageId, text, { parse_mode: "HTML", reply_markup: keyboard }); }

export async function handleModelCenterCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("mc:")) return false;
  try {
    if (data === MODEL_CENTER_PRICE_LEGEND) {
      await ctx.answerCallbackQuery({ text: getFreeModelDetectionEnabled() ? PRICE_LEGEND : "Free Model Detection is OFF.", show_alert: true });
      return true;
    }
    if (data.startsWith(MODEL_CENTER_PRICE_PAGE_PREFIX)) {
      const [id, pageText, extra] = data.slice(MODEL_CENTER_PRICE_PAGE_PREFIX.length).split(":");
      const providerID = id ? resolvePriceViewProvider(id) : undefined;
      if (!providerID || !pageText || !/^\d+$/.test(pageText) || extra !== undefined) throw new PriceViewExpiredError();
      await ctx.answerCallbackQuery().catch(() => {});
      const provider = (await getProviders()).find((item) => item.id === providerID);
      if (!provider) throw new PriceViewExpiredError();
      return await render(ctx, await buildModelCenterProvider(provider, Number(pageText), fetchCurrentModel(), id));
    }
    if (data === MODEL_CENTER_ROOT) return await render(ctx, await buildModelCenterRoot(fetchCurrentModel()));
    if (data === MODEL_CENTER_FAVORITES) return await render(ctx, await buildModelCenterList("favorites", fetchCurrentModel()));
    if (data === MODEL_CENTER_RECENT) return await render(ctx, await buildModelCenterList("recent", fetchCurrentModel()));
    if (data === MODEL_CENTER_PROVIDERS) return await render(ctx, await buildModelCenterProviders());
    if (data === MODEL_CENTER_SEARCH || data === MODEL_CENTER_SEARCH_AGAIN) return beginSearch(ctx);
    if (data === MODEL_CENTER_SEARCH_CANCEL) {
      interactionManager.clear("model_search_cancelled");
      return await render(ctx, await buildModelCenterRoot(fetchCurrentModel()));
    }
    if (data.startsWith(MODEL_CENTER_PROVIDER_PREFIX)) {
      const parts = data.slice(MODEL_CENTER_PROVIDER_PREFIX.length).split(":");
      if (parts.length !== 2) return true;
      const providerID = decodeURIComponent(parts[0] ?? "");
      const page = Number.parseInt(parts[1] ?? "0", 10);
      if (!providerID || !Number.isInteger(page) || page < 0) return true;
      await ctx.answerCallbackQuery().catch(() => {});
      const provider = (await getProviders()).find((item) => item.id === providerID);
      if (!provider) { await ctx.answerCallbackQuery({ text: "Provider is no longer available.", show_alert: true }).catch(() => {}); return true; }
      return await render(ctx, await buildModelCenterProvider(provider, page, fetchCurrentModel()));
    }
    if (data.startsWith(MODEL_CENTER_FAVORITE_PREFIX)) {
      const token = data.slice(MODEL_CENTER_FAVORITE_PREFIX.length);
      const model = resolveModelCenterAction(token);
      const target = resolveModelCenterFavoriteTarget(token);
      if (!model || !target || !(await isSelectableChatModel(model.providerID, model.modelID))) { await ctx.answerCallbackQuery({ text: "This model button is stale. Reopen Model Center.", show_alert: true }).catch(() => {}); return true; }
      const added = await toggleFavoriteModel(model);
      await ctx.answerCallbackQuery({ text: added ? "Added to favorites." : "Removed from favorites." }).catch(() => {});
      return await renderFavoriteTarget(ctx, target);
    }
    if (data.startsWith(MODEL_CENTER_SELECT_PREFIX)) {
      const model = resolveModelCenterAction(data.slice(MODEL_CENTER_SELECT_PREFIX.length));
      if (!model || !(await isSelectableChatModel(model.providerID, model.modelID))) { await ctx.answerCallbackQuery({ text: "This model button is stale. Reopen Model Center.", show_alert: true }).catch(() => {}); return true; }
      await applyModelSelectionAndNotify(ctx, model);
      return true;
    }
    return false;
  } catch (error) {
    if (error instanceof PriceViewExpiredError) {
      await ctx.answerCallbackQuery({ text: error.message, show_alert: true }).catch(() => {});
      return true;
    }
    logger.error("[ModelCenter] Callback failed", error);
    await ctx.answerCallbackQuery({ text: "Model Center action failed.", show_alert: true }).catch(() => {});
    return true;
  }
}

async function renderFavoriteTarget(ctx: Context, target: ModelCenterFavoriteTarget): Promise<boolean> {
  switch (target.kind) {
    case "root": return await render(ctx, await buildModelCenterRoot(fetchCurrentModel()));
    case "list": return await render(ctx, await buildModelCenterList(target.list, fetchCurrentModel()));
    case "provider": {
      const provider = (await getProviders()).find((item) => item.id === target.providerID);
      if (!provider) return await render(ctx, await buildModelCenterProviders());
      return await render(ctx, await buildModelCenterProvider(provider, target.page, fetchCurrentModel(), target.viewID));
    }
    case "search": return await render(ctx, await buildModelCenterSearchResults(target.query, fetchCurrentModel()));
  }
}

async function beginSearch(ctx: Context): Promise<boolean> {
  const messageId = getCallbackMessageId(ctx);
  if (messageId === null || !ctx.chat?.id) {
    await ctx.answerCallbackQuery({ text: "This menu has expired. Reopen Model Center.", show_alert: true }).catch(() => {});
    return true;
  }
  await ctx.answerCallbackQuery().catch(() => {});
  const threadId = getTopicThreadId(ctx);
  interactionManager.start({
    kind: "custom",
    expectedInput: "mixed",
    metadata: {
      flow: SEARCH_FLOW,
      stage: "input" satisfies ModelCenterSearchState["stage"],
      messageId,
      chatId: ctx.chat.id,
      ...(threadId !== undefined ? { threadId } : {}),
    },
  });
  await editSearchPanel(ctx, messageId, "🔎 <b>Search models</b>\n\nSend part of a model name, ID, or provider.", searchInputKeyboard());
  return true;
}

export async function handleModelSearchTextInput(ctx: Context): Promise<boolean> {
  const state = interactionManager.getSnapshot();
  if (!state || state.kind !== "custom" || state.metadata.flow !== SEARCH_FLOW || state.metadata.stage !== "input") return false;
  if (typeof state.metadata.chatId === "number" && state.metadata.chatId !== ctx.chat?.id) return false;
  if (typeof state.metadata.threadId === "number" && getMessageThreadId(ctx) !== state.metadata.threadId) return false;
  const messageId = typeof state.metadata.messageId === "number" ? state.metadata.messageId : null;
  if (messageId === null || !ctx.chat?.id) { interactionManager.clear("model_search_missing_panel"); return false; }

  const query = ctx.message?.text?.trim() ?? "";
  await deleteSearchInput(ctx);
  if (!query) {
    await editSearchPanel(ctx, messageId, "🔎 <b>Search models</b>\n\n❌ Send a model name, ID, or provider to search.", searchInputKeyboard());
    return true;
  }
  try {
    const view = await buildModelCenterSearchResults(query, fetchCurrentModel());
    await editSearchPanel(ctx, messageId, view.text, view.keyboard);
    const threadId = getMessageThreadId(ctx);
    interactionManager.start({
      kind: "inline",
      expectedInput: "callback",
      metadata: {
        menuKind: "model",
        flow: SEARCH_FLOW,
        stage: "results" satisfies ModelCenterSearchState["stage"],
        messageId,
        chatId: ctx.chat.id,
        ...(threadId !== undefined ? { threadId } : {}),
      },
    });
    return true;
  } catch (error) {
    logger.error("[ModelCenter] Search failed", error);
    interactionManager.transition({
      expectedInput: "mixed",
      metadata: {
        flow: SEARCH_FLOW,
        stage: "input" satisfies ModelCenterSearchState["stage"],
        messageId,
        chatId: ctx.chat.id,
        ...(getMessageThreadId(ctx) !== undefined ? { threadId: getMessageThreadId(ctx) } : {}),
      },
    });
    await editSearchPanel(ctx, messageId, "❌ <b>Model search failed.</b>\n\nSend another query, go Back, or return Home.", searchInputKeyboard()).catch(() => {});
    return true;
  }
}

async function applyModelSelectionAndNotify(ctx: Context, modelInfo: ModelInfo): Promise<void> {
  const threadId = getTopicThreadId(ctx);
  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id;
  const topicBinding = chatId && typeof threadId === "number" && threadId > 1
    ? await findTelegramTopicBindingByThread(chatId, threadId)
    : null;
  const topicSessionId = topicBinding?.sessionId;
  const currentSession = topicSessionId
    ? { id: topicSessionId, title: topicBinding?.title ?? "Telegram Topic", directory: topicBinding.directory }
    : getCurrentSession();
  const isTopic = Boolean(topicBinding && topicSessionId);
  const activeSessionId = topicSessionId ?? currentSession?.id;

  if (chatId) keyboardManager.initialize(ctx.api, chatId, activeSessionId, threadId);
  const previousModel = fetchCurrentModel();

  interactionManager.clear("model_selected");
  selectModel(modelInfo);
  if (!getCurrentTopicSettings()) updateTopicDefaults({ model: modelInfo });
  await recordRecentModel(modelInfo);

  if (
    previousModel.providerID !== modelInfo.providerID ||
    previousModel.modelID !== modelInfo.modelID
  ) {
    logger.info(
      `[ModelCenter] Switched model without rotating session: ${previousModel.providerID}/${previousModel.modelID} -> ${modelInfo.providerID}/${modelInfo.modelID}, session=${activeSessionId ?? "none"}, topic=${isTopic ? `${chatId}:${threadId}` : "global"}`,
    );
  }

  keyboardManager.updateModel(modelInfo, activeSessionId);
  await pinnedMessageManager.refreshContextLimit();
  const currentAgent = await resolveProjectAgent(getStoredAgent());
  const contextInfo = pinnedMessageManager.getContextInfo() ?? (pinnedMessageManager.getContextLimit() > 0 ? { tokensUsed: 0, tokensLimit: pinnedMessageManager.getContextLimit() } : null);
  keyboardManager.updateAgent(currentAgent, activeSessionId);
  if (contextInfo) keyboardManager.updateContext(contextInfo.tokensUsed, contextInfo.tokensLimit, activeSessionId);

  const capabilities = await getModelCapabilities(modelInfo.providerID, modelInfo.modelID);
  const icons = formatCapabilitiesIcons(capabilities);
  const suffix = icons ? `\n${icons}` : "";

  if (isTopic) {
    const topicKeyboard = keyboardManager.getKeyboard(activeSessionId);
    if (!topicKeyboard) throw new Error(`No Topic keyboard state available after model selection: session=${activeSessionId}`);
    await switched(ctx, `Model changed to ${formatModelForDisplay(modelInfo.providerID, modelInfo.modelID, modelInfo.name)}${suffix}`, topicKeyboard);
    return;
  }

  const keyboard = createMainKeyboard(currentAgent, modelInfo, contextInfo ?? undefined, formatVariantForButton(modelInfo.variant || "default"));
  await switched(ctx, `Model changed to ${formatModelForDisplay(modelInfo.providerID, modelInfo.modelID, modelInfo.name)}${suffix}`, keyboard);
}

async function render(ctx: Context, view: { text: string; keyboard: InlineKeyboard }): Promise<boolean> {
  await ctx.answerCallbackQuery().catch(() => {});
  await ctx.editMessageText(view.text, { reply_markup: view.keyboard, parse_mode: "HTML" }).catch(() => {});
  const threadId = getTopicThreadId(ctx);
  interactionManager.transition({ expectedInput: "callback", metadata: { menuKind: "model", messageId: ctx.callbackQuery?.message?.message_id, ...(ctx.chat ? { chatId: ctx.chat.id } : {}), ...(threadId !== undefined ? { threadId } : {}) } });
  return true;
}