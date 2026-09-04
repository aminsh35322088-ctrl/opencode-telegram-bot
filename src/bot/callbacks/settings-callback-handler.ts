import type { Context } from "grammy";
import type { InlineKeyboard } from "grammy";
import { mcpsCommand } from "../commands/mcp-catalog-command.js";
import { skillsCommand } from "../commands/skills-catalog-command.js";
import { commandsCommand } from "../commands/command-catalog-command.js";
import { showAgentSelectionMenu } from "../menus/agent-selection-menu.js";
import { showVariantSelectionMenu } from "../menus/variant-selection-menu.js";
import { getCompactOutputMode, getMessageFormatMode, getPromptQueueEnabled, getResponseStreamingMode, getSendDiffFileAttachments, getShowAssistantRunFooter, getShowThinkingContent, getTopicDefaults, setCompactOutputMode, setMessageFormatMode, setPromptQueueEnabled, setResponseStreamingMode, setSendDiffFileAttachments, setShowAssistantRunFooter, setShowThinkingContent, updateTopicDefaults, type MessageFormatMode, type ResponseStreamingMode } from "../../app/stores/settings-store.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { appendInlineMenuCancelButton, ensureActiveInlineMenu } from "../menus/inline-menu.js";
import { showModelCenterMenu } from "../menus/model-center-menu.js";
import { buildAdvancedSettingsView, buildAppearanceSettingsView, buildContextSettingsView, buildNotificationsSettingsView, buildSettingsMenuView, buildTopicDefaultsSettingsView, SETTINGS_AGENT_CALLBACK, SETTINGS_ADVANCED_CALLBACK, SETTINGS_APPEARANCE_CALLBACK, SETTINGS_ASSISTANT_FOOTER_CALLBACK, SETTINGS_BACK_CALLBACK, SETTINGS_COMMANDS_CALLBACK, SETTINGS_COMPACT_OUTPUT_CALLBACK, SETTINGS_CONTEXT_CALLBACK, SETTINGS_DEFAULT_COMPACT_CALLBACK, SETTINGS_DEFAULT_DIFF_CALLBACK, SETTINGS_DEFAULT_FOOTER_CALLBACK, SETTINGS_DEFAULT_FORMAT_CALLBACK, SETTINGS_DEFAULT_QUEUE_CALLBACK, SETTINGS_DEFAULT_STREAMING_CALLBACK, SETTINGS_DEFAULT_THINKING_CALLBACK, SETTINGS_DIFF_FILES_CALLBACK, SETTINGS_MESSAGE_FORMAT_CALLBACK, SETTINGS_MCP_CALLBACK, SETTINGS_MODEL_CALLBACK, SETTINGS_NOTIFICATIONS_CALLBACK, SETTINGS_PROMPT_QUEUE_CALLBACK, SETTINGS_RESPONSE_STREAMING_CALLBACK, SETTINGS_SKILLS_CALLBACK, SETTINGS_THINKING_CONTENT_CALLBACK, SETTINGS_TOPIC_DEFAULTS_CALLBACK, SETTINGS_VARIANT_CALLBACK, SETTINGS_CALLBACK_PREFIX } from "../menus/settings-menu.js";

function nextResponseStreamingMode(mode: ResponseStreamingMode): ResponseStreamingMode { return mode === "edit" ? "draft" : "edit"; }
function nextMessageFormatMode(mode: MessageFormatMode): MessageFormatMode { return mode === "markdown" ? "raw" : "markdown"; }
async function renderSettingsView(ctx: Context, view: { text: string; keyboard: InlineKeyboard }): Promise<void> { await ctx.editMessageText(view.text, { reply_markup: appendInlineMenuCancelButton(view.keyboard, "settings") }); }

export async function handleSettingsCallback(ctx: Context): Promise<boolean> {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith(SETTINGS_CALLBACK_PREFIX)) return false;
  if (!(await ensureActiveInlineMenu(ctx, "settings"))) return true;
  try {
    switch (callbackData) {
      case SETTINGS_MODEL_CALLBACK: await ctx.answerCallbackQuery(); await showModelCenterMenu(ctx); return true;
      case SETTINGS_AGENT_CALLBACK: await ctx.answerCallbackQuery(); await showAgentSelectionMenu(ctx); return true;
      case SETTINGS_VARIANT_CALLBACK: await ctx.answerCallbackQuery(); await showVariantSelectionMenu(ctx); return true;
      case SETTINGS_APPEARANCE_CALLBACK: await ctx.answerCallbackQuery(); await renderSettingsView(ctx, buildAppearanceSettingsView()); return true;
      case SETTINGS_NOTIFICATIONS_CALLBACK: await ctx.answerCallbackQuery(); await renderSettingsView(ctx, buildNotificationsSettingsView()); return true;
      case SETTINGS_CONTEXT_CALLBACK: await ctx.answerCallbackQuery(); await renderSettingsView(ctx, buildContextSettingsView()); return true;
      case SETTINGS_ADVANCED_CALLBACK: await ctx.answerCallbackQuery(); await renderSettingsView(ctx, buildAdvancedSettingsView()); return true;
      case SETTINGS_TOPIC_DEFAULTS_CALLBACK: await ctx.answerCallbackQuery(); await renderSettingsView(ctx, buildTopicDefaultsSettingsView()); return true;
      case SETTINGS_MCP_CALLBACK: await ctx.answerCallbackQuery(); await mcpsCommand(ctx as never); return true;
      case SETTINGS_SKILLS_CALLBACK: await ctx.answerCallbackQuery(); await skillsCommand(ctx as never); return true;
      case SETTINGS_COMMANDS_CALLBACK: await ctx.answerCallbackQuery(); await commandsCommand(ctx as never); return true;
      case SETTINGS_BACK_CALLBACK: await ctx.answerCallbackQuery(); await renderSettingsView(ctx, buildSettingsMenuView()); return true;
    }

    switch (callbackData) {
      case SETTINGS_DEFAULT_COMPACT_CALLBACK: updateTopicDefaults({ compactOutputMode: !getTopicDefaults().compactOutputMode }); break;
      case SETTINGS_DEFAULT_THINKING_CALLBACK: updateTopicDefaults({ showThinkingContent: !getTopicDefaults().showThinkingContent }); break;
      case SETTINGS_DEFAULT_STREAMING_CALLBACK: updateTopicDefaults({ responseStreamingMode: nextResponseStreamingMode(getTopicDefaults().responseStreamingMode) }); break;
      case SETTINGS_DEFAULT_FORMAT_CALLBACK: updateTopicDefaults({ messageFormatMode: nextMessageFormatMode(getTopicDefaults().messageFormatMode) }); break;
      case SETTINGS_DEFAULT_FOOTER_CALLBACK: updateTopicDefaults({ showAssistantRunFooter: !getTopicDefaults().showAssistantRunFooter }); break;
      case SETTINGS_DEFAULT_DIFF_CALLBACK: updateTopicDefaults({ sendDiffFileAttachments: !getTopicDefaults().sendDiffFileAttachments }); break;
      case SETTINGS_DEFAULT_QUEUE_CALLBACK: updateTopicDefaults({ promptQueueEnabled: !getTopicDefaults().promptQueueEnabled }); break;
      default: {
        let destination: () => { text: string; keyboard: InlineKeyboard } = buildAppearanceSettingsView;
        switch (callbackData) {
          case SETTINGS_COMPACT_OUTPUT_CALLBACK: setCompactOutputMode(!getCompactOutputMode()); break;
          case SETTINGS_THINKING_CONTENT_CALLBACK: setShowThinkingContent(!getShowThinkingContent()); break;
          case SETTINGS_RESPONSE_STREAMING_CALLBACK: setResponseStreamingMode(nextResponseStreamingMode(getResponseStreamingMode())); break;
          case SETTINGS_MESSAGE_FORMAT_CALLBACK: setMessageFormatMode(nextMessageFormatMode(getMessageFormatMode())); break;
          case SETTINGS_DIFF_FILES_CALLBACK: setSendDiffFileAttachments(!getSendDiffFileAttachments()); break;
          case SETTINGS_ASSISTANT_FOOTER_CALLBACK: setShowAssistantRunFooter(!getShowAssistantRunFooter()); break;
          case SETTINGS_PROMPT_QUEUE_CALLBACK: setPromptQueueEnabled(!getPromptQueueEnabled()); destination = buildNotificationsSettingsView; break;
          default: await ctx.answerCallbackQuery({ text: t("callback.processing_error") }); return true;
        }
        await ctx.answerCallbackQuery({ text: t("settings.saved") });
        await renderSettingsView(ctx, destination());
        return true;
      }
    }
    await ctx.answerCallbackQuery({ text: t("settings.saved") });
    await renderSettingsView(ctx, buildTopicDefaultsSettingsView());
    return true;
  } catch (error) {
    logger.error("[Settings] Error handling settings callback:", error);
    await ctx.answerCallbackQuery({ text: t("callback.processing_error") }).catch(() => {});
    return true;
  }
}
