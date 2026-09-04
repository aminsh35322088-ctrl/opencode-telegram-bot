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
  MODEL_CENTER_SEARCH,
  MODEL_CENTER_SEARCH_AGAIN,
  MODEL_CENTER_SEARCH_CANCEL,
  MODEL_CENTER_SEARCH_RESULT_PREFIX,
  MODEL_CENTER_SELECT_PREFIX,
  resolveModelCenterAction,
} from "../menus/model-center-menu.js";
import { fetchCurrentModel, getProviders, selectModel } from "../../app/services/model-selection-service.js";
import { recordRecentModel, toggleFavoriteModel } from "../../app/services/model-preferences-service.js";
import { formatVariantForButton } from "../../app/services/variant-selection-service.js";
import { formatModelForDisplay, type ModelInfo } from "../../app/types/model.js";
import { resolveProjectAgent, getStoredAgent } from "../../app/services/agent-selection-service.js";
import { createMainKeyboard } from "../keyboards/main-reply-keyboard.js";
import { keyboardManager } from "../keyboards/keyboard-manager.js";
import { pinnedMessageManager } from "../pinned/pinned-message-manager.js";
import { switched } from "./feedback.js";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import { logger } from "../../utils/logger.js";

const SEARCH_FLOW = "model-search";

interface ModelCenterSearchState {
  stage: "input" | "results";
}

export async function handleModelCenterCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("mc:")) return false;

  try {
    if (data === MODEL_CENTER_ROOT) return await render(ctx, await buildModelCenterRoot(fetchCurrentModel()));
    if (data === MODEL_CENTER_FAVORITES) return await render(ctx, await buildModelCenterList("favorites", fetchCurrentModel()));
    if (data === MODEL_CENTER_RECENT) return await render(ctx, await buildModelCenterList("recent", fetchCurrentModel()));
    if (data === MODEL_CENTER_PROVIDERS) return await render(ctx, await buildModelCenterProviders());
    if (data === MODEL_CENTER_SEARCH || data === MODEL_CENTER_SEARCH_AGAIN) return beginSearch(ctx);
    if (data === MODEL_CENTER_SEARCH_CANCEL) {
      await ctx.answerCallbackQuery().catch(() => {});
      interactionManager.clear("model_search_cancelled");
      await ctx.deleteMessage().catch(() => {});
      return true;
    }
    if (data.startsWith(MODEL_CENTER_PROVIDER_PREFIX)) {
      const parts = data.slice(MODEL_CENTER_PROVIDER_PREFIX.length).split(":");
      if (parts.length !== 2) return true;
      const providerID = decodeURIComponent(parts[0] ?? "");
      const page = Number.parseInt(parts[1] ?? "0", 10);
      if (!providerID || !Number.isInteger(page) || page < 0) return true;
      const provider = (await getProviders()).find((item) => item.id === providerID);
      if (!provider) {
        await ctx.answerCallbackQuery({ text: "Provider is no longer available.", show_alert: true }).catch(() => {});
        return true;
      }
      return await render(ctx, await buildModelCenterProvider(provider, page, fetchCurrentModel()));
    }
    if (data.startsWith(MODEL_CENTER_FAVORITE_PREFIX)) {
      const model = resolveModelCenterAction(data.slice(MODEL_CENTER_FAVORITE_PREFIX.length));
      if (!model) {
        await ctx.answerCallbackQuery({ text: "This model button is stale. Reopen Model Center.", show_alert: true }).catch(() => {});
        return true;
      }
      const added = await toggleFavoriteModel(model);
      await ctx.answerCallbackQuery({ text: added ? "Added to favorites." : "Removed from favorites." }).catch(() => {});
      return await render(ctx, await buildModelCenterRoot(fetchCurrentModel()));
    }
    if (data.startsWith(MODEL_CENTER_SELECT_PREFIX) || data.startsWith(MODEL_CENTER_SEARCH_RESULT_PREFIX)) {
      const prefix = data.startsWith(MODEL_CENTER_SELECT_PREFIX) ? MODEL_CENTER_SELECT_PREFIX : MODEL_CENTER_SEARCH_RESULT_PREFIX;
      const model = resolveModelCenterAction(data.slice(prefix.length));
      if (!model) {
        await ctx.answerCallbackQuery({ text: "This model button is stale. Reopen Model Center.", show_alert: true }).catch(() => {});
        return true;
      }
      await applyModelSelectionAndNotify(ctx, model);
      return true;
    }
    return false;
  } catch (error) {
    logger.error("[ModelCenter] Callback failed", error);
    await ctx.answerCallbackQuery({ text: "Model Center action failed.", show_alert: true }).catch(() => {});
    return true;
  }
}

async function beginSearch(ctx: Context): Promise<boolean> {
  await ctx.answerCallbackQuery().catch(() => {});
  await ctx.deleteMessage().catch(() => {});
  interactionManager.start({
    kind: "custom",
    expectedInput: "text",
    metadata: { flow: SEARCH_FLOW, stage: "input" satisfies ModelCenterSearchState["stage"] },
  });
  await ctx.reply("🔎 <b>Search models</b>\n\nSend part of a model name or ID.", { parse_mode: "HTML" });
  return true;
}

export async function handleModelSearchTextInput(ctx: Context): Promise<boolean> {
  const state = interactionManager.getSnapshot();
  if (!state || state.kind !== "custom" || state.metadata.flow !== SEARCH_FLOW || state.metadata.stage !== "input") return false;

  const query = ctx.message?.text?.trim() ?? "";
  if (!query) {
    await ctx.reply("🔎 Send a model name or ID to search.");
    return true;
  }

  try {
    const view = await buildModelCenterSearchResults(query, fetchCurrentModel());
    await ctx.reply(view.text, { parse_mode: "HTML", reply_markup: view.keyboard });
    interactionManager.start({
      kind: "inline",
      expectedInput: "callback",
      metadata: { menuKind: "model", flow: SEARCH_FLOW, stage: "results" satisfies ModelCenterSearchState["stage"] },
    });
    return true;
  } catch (error) {
    logger.error("[ModelCenter] Search failed", error);
    interactionManager.clear("model_search_error");
    await ctx.reply("❌ Model search failed. Reopen Model Center and try again.");
    return true;
  }
}

async function applyModelSelectionAndNotify(ctx: Context, modelInfo: ModelInfo): Promise<void> {
  if (ctx.chat) keyboardManager.initialize(ctx.api, ctx.chat.id);

  selectModel(modelInfo);
  await recordRecentModel(modelInfo);
  keyboardManager.updateModel(modelInfo);
  await pinnedMessageManager.refreshContextLimit();

  const currentAgent = await resolveProjectAgent(getStoredAgent());
  const contextInfo = pinnedMessageManager.getContextInfo() ?? (pinnedMessageManager.getContextLimit() > 0 ? { tokensUsed: 0, tokensLimit: pinnedMessageManager.getContextLimit() } : null);
  keyboardManager.updateAgent(currentAgent);
  if (contextInfo) keyboardManager.updateContext(contextInfo.tokensUsed, contextInfo.tokensLimit);

  const keyboard = createMainKeyboard(currentAgent, modelInfo, contextInfo ?? undefined, formatVariantForButton(modelInfo.variant || "default"));
  await ctx.answerCallbackQuery().catch(() => {});
  await switched(ctx, `Model changed to ${formatModelForDisplay(modelInfo.providerID, modelInfo.modelID)}`, keyboard);
}

async function render(ctx: Context, view: { text: string; keyboard: InlineKeyboard }): Promise<boolean> {
  await ctx.answerCallbackQuery().catch(() => {});
  await ctx.editMessageText(view.text, { reply_markup: view.keyboard, parse_mode: "HTML" }).catch(() => {});
  interactionManager.transition({ expectedInput: "callback", metadata: { menuKind: "model", messageId: ctx.callbackQuery?.message?.message_id } });
  return true;
}
