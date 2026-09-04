import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { buildModelCenterList, buildModelCenterProvider, buildModelCenterProviders, buildModelCenterRoot, MODEL_CENTER_FAVORITE_PREFIX, MODEL_CENTER_FAVORITES, MODEL_CENTER_PROVIDERS, MODEL_CENTER_PROVIDER_PREFIX, MODEL_CENTER_RECENT, MODEL_CENTER_ROOT, MODEL_CENTER_SELECT_PREFIX, resolveModelCenterAction } from "../menus/model-center-menu.js";
import { getProviders, fetchCurrentModel, selectModel } from "../../app/services/model-selection-service.js";
import { recordRecentModel, toggleFavoriteModel } from "../../app/services/model-preferences-service.js";
import { formatVariantForButton } from "../../app/services/variant-selection-service.js";
import { formatModelForDisplay } from "../../app/types/model.js";
import { resolveProjectAgent, getStoredAgent } from "../../app/services/agent-selection-service.js";
import { createMainKeyboard } from "../keyboards/main-reply-keyboard.js";
import { keyboardManager } from "../keyboards/keyboard-manager.js";
import { pinnedMessageManager } from "../pinned/pinned-message-manager.js";
import { switched } from "./feedback.js";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import { logger } from "../../utils/logger.js";

export async function handleModelCenterCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("mc:")) return false;
  try {
    if (data === MODEL_CENTER_ROOT) return await render(ctx, await buildModelCenterRoot(fetchCurrentModel()));
    if (data === MODEL_CENTER_FAVORITES) return await render(ctx, await buildModelCenterList("favorites", fetchCurrentModel()));
    if (data === MODEL_CENTER_RECENT) return await render(ctx, await buildModelCenterList("recent", fetchCurrentModel()));
    if (data === MODEL_CENTER_PROVIDERS) return await render(ctx, await buildModelCenterProviders());
    if (data.startsWith(MODEL_CENTER_PROVIDER_PREFIX)) {
      const parts = data.slice(MODEL_CENTER_PROVIDER_PREFIX.length).split(":");
      const providerID = decodeURIComponent(parts[0] ?? "");
      const page = Number.parseInt(parts[1] ?? "0", 10);
      if (!providerID || !Number.isInteger(page) || page < 0) return true;
      const provider = (await getProviders()).find((item) => item.id === providerID);
      if (!provider) { await ctx.answerCallbackQuery({ text: "Provider is no longer available.", show_alert: true }).catch(() => {}); return true; }
      return await render(ctx, await buildModelCenterProvider(provider, page, fetchCurrentModel()));
    }
    if (data.startsWith(MODEL_CENTER_FAVORITE_PREFIX)) {
      const model = resolveModelCenterAction(data.slice(MODEL_CENTER_FAVORITE_PREFIX.length));
      if (!model) { await ctx.answerCallbackQuery({ text: "This model button is stale. Reopen Model Center.", show_alert: true }).catch(() => {}); return true; }
      const added = await toggleFavoriteModel(model);
      await ctx.answerCallbackQuery({ text: added ? "Added to favorites." : "Removed from favorites." }).catch(() => {});
      return await render(ctx, await buildModelCenterRoot(fetchCurrentModel()));
    }
    if (data.startsWith(MODEL_CENTER_SELECT_PREFIX)) {
      const model = resolveModelCenterAction(data.slice(MODEL_CENTER_SELECT_PREFIX.length));
      if (!model) { await ctx.answerCallbackQuery({ text: "This model button is stale. Reopen Model Center.", show_alert: true }).catch(() => {}); return true; }
      selectModel(model);
      await recordRecentModel(model);
      if (ctx.chat) keyboardManager.initialize(ctx.api, ctx.chat.id);
      keyboardManager.updateModel(model);
      await pinnedMessageManager.refreshContextLimit();
      const currentAgent = await resolveProjectAgent(getStoredAgent());
      keyboardManager.updateAgent(currentAgent);
      const contextInfo = pinnedMessageManager.getContextInfo() ?? (pinnedMessageManager.getContextLimit() > 0 ? { tokensUsed: 0, tokensLimit: pinnedMessageManager.getContextLimit() } : null);
      if (contextInfo) keyboardManager.updateContext(contextInfo.tokensUsed, contextInfo.tokensLimit);
      const keyboard = createMainKeyboard(currentAgent, model, contextInfo ?? undefined, formatVariantForButton(model.variant || "default"));
      await ctx.answerCallbackQuery().catch(() => {});
      await switched(ctx, `Model changed to ${formatModelForDisplay(model.providerID, model.modelID)}`, keyboard);
      return true;
    }
    return false;
  } catch (error) {
    logger.error("[ModelCenter] Callback failed", error);
    await ctx.answerCallbackQuery({ text: "Model Center action failed.", show_alert: true }).catch(() => {});
    return true;
  }
}

async function render(ctx: Context, view: { text: string; keyboard: InlineKeyboard }): Promise<boolean> {
  await ctx.answerCallbackQuery().catch(() => {});
  await ctx.editMessageText(view.text, { reply_markup: view.keyboard, parse_mode: "HTML" }).catch(() => {});
  interactionManager.transition({ expectedInput: "callback", metadata: { menuKind: "model", messageId: ctx.callbackQuery?.message?.message_id } });
  return true;
}
