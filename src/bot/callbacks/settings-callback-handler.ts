import type { Context } from "grammy";
import type { InlineKeyboard } from "grammy";
import { handleAiRoleCallback } from "./ai-role-selection-callback-handler.js";
import { mcpsCommand } from "../commands/mcp-catalog-command.js";
import { skillsCommand } from "../commands/skills-catalog-command.js";
import { commandsCommand } from "../commands/command-catalog-command.js";
import {
  getCompactOutputMode,
  getPromptQueueEnabled,
  getResponseStreamingMode,
  getSendDiffFileAttachments,
  getShowAssistantRunFooter,
  getShowThinkingContent,
  setCompactOutputMode,
  setPromptQueueEnabled,
  setResponseStreamingMode,
  setSendDiffFileAttachments,
  setShowAssistantRunFooter,
  setShowThinkingContent,
  type ResponseStreamingMode,
} from "../../app/stores/settings-store.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { appendInlineMenuCancelButton, ensureActiveInlineMenu } from "../menus/inline-menu.js";
import {
  buildAdvancedSettingsView,
  buildAppearanceSettingsView,
  buildContextSettingsView,
  buildNotificationsSettingsView,
  buildSettingsMenuView,
  SETTINGS_AI_RULES_CALLBACK,
  SETTINGS_ADVANCED_CALLBACK,
  SETTINGS_APPEARANCE_CALLBACK,
  SETTINGS_ASSISTANT_FOOTER_CALLBACK,
  SETTINGS_BACK_CALLBACK,
  SETTINGS_COMMANDS_CALLBACK,
  SETTINGS_COMPACT_OUTPUT_CALLBACK,
  SETTINGS_CONTEXT_CALLBACK,
  SETTINGS_DIFF_FILES_CALLBACK,
  SETTINGS_MCP_CALLBACK,
  SETTINGS_NOTIFICATIONS_CALLBACK,
  SETTINGS_PROMPT_QUEUE_CALLBACK,
  SETTINGS_RESPONSE_STREAMING_CALLBACK,
  SETTINGS_SKILLS_CALLBACK,
  SETTINGS_THINKING_CONTENT_CALLBACK,
  SETTINGS_CALLBACK_PREFIX,
} from "../menus/settings-menu.js";

function getNextResponseStreamingMode(mode: ResponseStreamingMode): ResponseStreamingMode {
  return mode === "edit" ? "draft" : "edit";
}

async function renderSettingsView(ctx: Context, view: { text: string; keyboard: InlineKeyboard }): Promise<void> {
  await ctx.editMessageText(view.text, {
    reply_markup: appendInlineMenuCancelButton(view.keyboard, "settings"),
  });
}

export async function handleSettingsCallback(ctx: Context): Promise<boolean> {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith(SETTINGS_CALLBACK_PREFIX)) return false;
  if (callbackData === SETTINGS_AI_RULES_CALLBACK) {
    await ctx.answerCallbackQuery().catch(() => {});
    return handleAiRoleCallback({
      ...ctx,
      callbackQuery: { ...ctx.callbackQuery!, data: "role:root" },
    } as Context);
  }

  if (!(await ensureActiveInlineMenu(ctx, "settings"))) return true;

  try {
    switch (callbackData) {
      case SETTINGS_APPEARANCE_CALLBACK:
        await ctx.answerCallbackQuery();
        await renderSettingsView(ctx, buildAppearanceSettingsView());
        return true;
      case SETTINGS_NOTIFICATIONS_CALLBACK:
        await ctx.answerCallbackQuery();
        await renderSettingsView(ctx, buildNotificationsSettingsView());
        return true;
      case SETTINGS_CONTEXT_CALLBACK:
        await ctx.answerCallbackQuery();
        await renderSettingsView(ctx, buildContextSettingsView());
        return true;
      case SETTINGS_ADVANCED_CALLBACK:
        await ctx.answerCallbackQuery();
        await renderSettingsView(ctx, buildAdvancedSettingsView());
        return true;
      case SETTINGS_MCP_CALLBACK:
        await ctx.answerCallbackQuery();
        await mcpsCommand(ctx as never);
        return true;
      case SETTINGS_SKILLS_CALLBACK:
        await ctx.answerCallbackQuery();
        await skillsCommand(ctx as never);
        return true;
      case SETTINGS_COMMANDS_CALLBACK:
        await ctx.answerCallbackQuery();
        await commandsCommand(ctx as never);
        return true;
      case SETTINGS_BACK_CALLBACK:
        await ctx.answerCallbackQuery();
        await renderSettingsView(ctx, buildSettingsMenuView());
        return true;
    }

    let destination: () => { text: string; keyboard: InlineKeyboard } = buildAppearanceSettingsView;
    switch (callbackData) {
      case SETTINGS_COMPACT_OUTPUT_CALLBACK:
        setCompactOutputMode(!getCompactOutputMode());
        break;
      case SETTINGS_THINKING_CONTENT_CALLBACK:
        setShowThinkingContent(!getShowThinkingContent());
        break;
      case SETTINGS_RESPONSE_STREAMING_CALLBACK:
        setResponseStreamingMode(getNextResponseStreamingMode(getResponseStreamingMode()));
        break;
      case SETTINGS_DIFF_FILES_CALLBACK:
        setSendDiffFileAttachments(!getSendDiffFileAttachments());
        break;
      case SETTINGS_ASSISTANT_FOOTER_CALLBACK:
        setShowAssistantRunFooter(!getShowAssistantRunFooter());
        break;
      case SETTINGS_PROMPT_QUEUE_CALLBACK:
        setPromptQueueEnabled(!getPromptQueueEnabled());
        destination = buildNotificationsSettingsView;
        break;
      default:
        await ctx.answerCallbackQuery({ text: t("callback.processing_error") });
        return true;
    }

    await ctx.answerCallbackQuery({ text: t("settings.saved") });
    await renderSettingsView(ctx, destination());
    return true;
  } catch (error) {
    logger.error("[Settings] Error handling settings callback:", error);
    await ctx.answerCallbackQuery({ text: t("callback.processing_error") }).catch(() => {});
    return true;
  }
}
