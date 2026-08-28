import type { Context } from "grammy";
import { showModelSelectionMenu } from "../menus/model-selection-menu.js";
import { getCompactOutputMode, getPromptQueueEnabled, getResponseStreamingMode, getSendDiffFileAttachments, getShowAssistantRunFooter, getShowThinkingContent, setCompactOutputMode, setPromptQueueEnabled, setResponseStreamingMode, setSendDiffFileAttachments, setShowAssistantRunFooter, setShowThinkingContent, type ResponseStreamingMode } from "../../app/stores/settings-store.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { appendInlineMenuCancelButton, ensureActiveInlineMenu } from "../menus/inline-menu.js";
import { buildAdvancedSettingsView, buildAppearanceSettingsView, buildContextSettingsView, buildNotificationsSettingsView, buildSettingsMenuView, SETTINGS_ADVANCED_CALLBACK, SETTINGS_APPEARANCE_CALLBACK, SETTINGS_ASSISTANT_FOOTER_CALLBACK, SETTINGS_BACK_CALLBACK, SETTINGS_CALLBACK_PREFIX, SETTINGS_COMPACT_OUTPUT_CALLBACK, SETTINGS_CONTEXT_CALLBACK, SETTINGS_DIFF_FILES_CALLBACK, SETTINGS_MODEL_CALLBACK, SETTINGS_NOTIFICATIONS_CALLBACK, SETTINGS_PROMPT_QUEUE_CALLBACK, SETTINGS_RESPONSE_STREAMING_CALLBACK, SETTINGS_THINKING_CONTENT_CALLBACK } from "../menus/settings-menu.js";

function getNextResponseStreamingMode(mode: ResponseStreamingMode): ResponseStreamingMode { return mode === "edit" ? "draft" : "edit"; }

async function renderSettingsView(ctx: Context, view: { text: string; keyboard: import("grammy").InlineKeyboard }): Promise<void> {
  await ctx.editMessageText(view.text, { reply_markup: appendInlineMenuCancelButton(view.keyboard, "settings") });
}

export async function handleSettingsCallback(ctx: Context): Promise<boolean> {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith(SETTINGS_CALLBACK_PREFIX)) return false;

  if (!(await ensureActiveInlineMenu(ctx, "settings"))) return true;

  try {
    if (callbackData === SETTINGS_MODEL_CALLBACK) {
      await ctx.answerCallbackQuery();
      await showModelSelectionMenu(ctx);
      return true;
    }

    if (callbackData === SETTINGS_APPEARANCE_CALLBACK) {
      await ctx.answerCallbackQuery();
      await renderSettingsView(ctx, buildAppearanceSettingsView());
      return true;
    }
    if (callbackData === SETTINGS_NOTIFICATIONS_CALLBACK) {
      await ctx.answerCallbackQuery();
      await renderSettingsView(ctx, buildNotificationsSettingsView());
      return true;
    }
    if (callbackData === SETTINGS_CONTEXT_CALLBACK) {
      await ctx.answerCallbackQuery();
      await renderSettingsView(ctx, buildContextSettingsView());
      return true;
    }
    if (callbackData === SETTINGS_ADVANCED_CALLBACK) {
      await ctx.answerCallbackQuery();
      await renderSettingsView(ctx, buildAdvancedSettingsView());
      return true;
    }
    if (callbackData === SETTINGS_BACK_CALLBACK) {
      await ctx.answerCallbackQuery();
      await renderSettingsView(ctx, buildSettingsMenuView());
      return true;
    }

    if (callbackData === SETTINGS_COMPACT_OUTPUT_CALLBACK) {
      setCompactOutputMode(!getCompactOutputMode());
    } else if (callbackData === SETTINGS_THINKING_CONTENT_CALLBACK) {
      setShowThinkingContent(!getShowThinkingContent());
    } else if (callbackData === SETTINGS_RESPONSE_STREAMING_CALLBACK) {
      setResponseStreamingMode(getNextResponseStreamingMode(getResponseStreamingMode()));
    } else if (callbackData === SETTINGS_DIFF_FILES_CALLBACK) {
      setSendDiffFileAttachments(!getSendDiffFileAttachments());
    } else if (callbackData === SETTINGS_PROMPT_QUEUE_CALLBACK) {
      setPromptQueueEnabled(!getPromptQueueEnabled());
    } else if (callbackData === SETTINGS_ASSISTANT_FOOTER_CALLBACK) {
      setShowAssistantRunFooter(!getShowAssistantRunFooter());
    } else {
      await ctx.answerCallbackQuery({ text: t("callback.processing_error") });
      return true;
    }

    await ctx.answerCallbackQuery({ text: t("settings.saved") });
    await renderSettingsView(ctx, buildAppearanceSettingsView());
    return true;
  } catch (error) {
    logger.error("[Settings] Error handling settings callback:", error);
    await ctx.answerCallbackQuery({ text: t("callback.processing_error") }).catch(() => {});
    return true;
  }
}
