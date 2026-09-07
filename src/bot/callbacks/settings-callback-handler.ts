import type { Context } from "grammy";
import type { InlineKeyboard } from "grammy";
import { mcpsCommand } from "../commands/mcp-catalog-command.js";
import { skillsCommand } from "../commands/skills-catalog-command.js";
import { commandsCommand } from "../commands/command-catalog-command.js";
import { showAgentSelectionMenu } from "../menus/agent-selection-menu.js";
import { showVariantSelectionMenu } from "../menus/variant-selection-menu.js";
import { getCompactOutputMode, getMessageFormatMode, getPromptQueueEnabled, getResponseStreamingMode, getSendDiffFileAttachments, getShowAssistantRunFooter, getShowThinkingContent, getTopicDefaults, getCurrentTopicSettings, setCompactOutputMode, setMessageFormatMode, setPromptQueueEnabled, setResponseStreamingMode, setSendDiffFileAttachments, setShowAssistantRunFooter, setShowThinkingContent, updateTopicDefaults, type MessageFormatMode, type ResponseStreamingMode } from "../../app/stores/settings-store.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { appendInlineMenuCancelButton, ensureActiveInlineMenu } from "../menus/inline-menu.js";
import { showModelCenterMenu } from "../menus/model-center-menu.js";
import { buildAdvancedSettingsView, buildAppearanceSettingsView, buildContextSettingsView, buildFactoryResetConfirmationView, buildFactoryResetFinalView, buildNotificationsSettingsView, buildResetHistoryConfirmationView, buildSettingsMenuView, buildTopicDefaultsSettingsView, SETTINGS_AGENT_CALLBACK, SETTINGS_ADVANCED_CALLBACK, SETTINGS_APPEARANCE_CALLBACK, SETTINGS_ASSISTANT_FOOTER_CALLBACK, SETTINGS_BACK_CALLBACK, SETTINGS_COMMANDS_CALLBACK, SETTINGS_COMPACT_OUTPUT_CALLBACK, SETTINGS_CONTEXT_CALLBACK, SETTINGS_DEFAULT_COMPACT_CALLBACK, SETTINGS_DEFAULT_DIFF_CALLBACK, SETTINGS_DEFAULT_FOOTER_CALLBACK, SETTINGS_DEFAULT_FORMAT_CALLBACK, SETTINGS_DEFAULT_QUEUE_CALLBACK, SETTINGS_DEFAULT_STREAMING_CALLBACK, SETTINGS_DEFAULT_THINKING_CALLBACK, SETTINGS_DIFF_FILES_CALLBACK, SETTINGS_FACTORY_RESET_CALLBACK, SETTINGS_FACTORY_RESET_CANCEL_CALLBACK, SETTINGS_FACTORY_RESET_CONFIRM_CALLBACK, SETTINGS_FACTORY_RESET_FINAL_CALLBACK, SETTINGS_MESSAGE_FORMAT_CALLBACK, SETTINGS_MCP_CALLBACK, SETTINGS_MODEL_CALLBACK, SETTINGS_NOTIFICATIONS_CALLBACK, SETTINGS_PROMPT_QUEUE_CALLBACK, SETTINGS_RESET_HISTORY_CALLBACK, SETTINGS_RESET_HISTORY_CANCEL_CALLBACK, SETTINGS_RESET_HISTORY_CONFIRM_CALLBACK, SETTINGS_RESPONSE_STREAMING_CALLBACK, SETTINGS_SKILLS_CALLBACK, SETTINGS_THINKING_CONTENT_CALLBACK, SETTINGS_TOPIC_DEFAULTS_CALLBACK, SETTINGS_VARIANT_CALLBACK, SETTINGS_CALLBACK_PREFIX } from "../menus/settings-menu.js";
import { factoryReset, resetHistory } from "../../app/services/telegram-reset-service.js";
import { keyboardManager } from "../keyboards/keyboard-manager.js";
import { getTopicRuntimeContext } from "../../app/services/topic-runtime-context.js";

function nextResponseStreamingMode(mode: ResponseStreamingMode): ResponseStreamingMode { return mode === "edit" ? "draft" : "edit"; }
function nextMessageFormatMode(mode: MessageFormatMode): MessageFormatMode { return mode === "markdown" ? "raw" : "markdown"; }
async function renderSettingsView(ctx: Context, view: { text: string; keyboard: InlineKeyboard }): Promise<void> { await ctx.editMessageText(view.text, { reply_markup: appendInlineMenuCancelButton(view.keyboard, "settings") }); }
function getCallbackChatId(ctx: Context): number | null { const id = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id; return typeof id === "number" ? id : null; }

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
      case SETTINGS_RESET_HISTORY_CALLBACK: await ctx.answerCallbackQuery(); await renderSettingsView(ctx, buildResetHistoryConfirmationView()); return true;
      case SETTINGS_RESET_HISTORY_CANCEL_CALLBACK: await ctx.answerCallbackQuery({ text: "History reset cancelled" }); await renderSettingsView(ctx, buildAdvancedSettingsView()); return true;
      case SETTINGS_RESET_HISTORY_CONFIRM_CALLBACK: {
        const chatId = getCallbackChatId(ctx);
        if (chatId === null) { await ctx.answerCallbackQuery({ text: "Chat context not found", show_alert: true }); return true; }
        await ctx.answerCallbackQuery({ text: "Resetting history…" });
        const result = await resetHistory(ctx.api, chatId);
        if (result.failed > 0) {
          await ctx.editMessageText(`⚠️ <b>History reset completed with ${result.failed} cleanup error(s).</b>\n\nDeleted Topics: ${result.deleted}\nRecovered orphaned workspaces: ${result.orphanedWorkspaces}\n\nCheck the bot logs before retrying.`, { parse_mode: "HTML" });
          return true;
        }
        await renderSettingsView(ctx, buildAdvancedSettingsView());
        return true;
      }
      case SETTINGS_FACTORY_RESET_CALLBACK: await ctx.answerCallbackQuery(); await renderSettingsView(ctx, buildFactoryResetConfirmationView()); return true;
      case SETTINGS_FACTORY_RESET_CANCEL_CALLBACK: await ctx.answerCallbackQuery({ text: "Factory reset cancelled" }); await renderSettingsView(ctx, buildAdvancedSettingsView()); return true;
      case SETTINGS_FACTORY_RESET_CONFIRM_CALLBACK: await ctx.answerCallbackQuery(); await renderSettingsView(ctx, buildFactoryResetFinalView()); return true;
      case SETTINGS_FACTORY_RESET_FINAL_CALLBACK: {
        const chatId = getCallbackChatId(ctx);
        if (chatId === null) { await ctx.answerCallbackQuery({ text: "Chat context not found", show_alert: true }); return true; }
        await ctx.answerCallbackQuery({ text: "Factory resetting…" });
        const result = await factoryReset(ctx.api, chatId);
        if (result.failed > 0) {
          await ctx.editMessageText(`⚠️ <b>Factory reset stopped with ${result.failed} cleanup error(s).</b>\n\nDeleted Topics: ${result.deleted}\nRecovered orphaned workspaces: ${result.orphanedWorkspaces}\n\nSaved settings were not reset because cleanup was incomplete. Check the bot logs.`, { parse_mode: "HTML" });
          return true;
        }
        await keyboardManager.sendMainInlineKeyboard(chatId, undefined, true);
        return true;
      }
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
        let refreshTopicKeyboard = false;
        switch (callbackData) {
          case SETTINGS_COMPACT_OUTPUT_CALLBACK: setCompactOutputMode(!getCompactOutputMode()); refreshTopicKeyboard = true; break;
          case SETTINGS_THINKING_CONTENT_CALLBACK: setShowThinkingContent(!getShowThinkingContent()); refreshTopicKeyboard = true; break;
          case SETTINGS_RESPONSE_STREAMING_CALLBACK: setResponseStreamingMode(nextResponseStreamingMode(getResponseStreamingMode())); refreshTopicKeyboard = true; break;
          case SETTINGS_MESSAGE_FORMAT_CALLBACK: setMessageFormatMode(nextMessageFormatMode(getMessageFormatMode())); refreshTopicKeyboard = true; break;
          case SETTINGS_DIFF_FILES_CALLBACK: setSendDiffFileAttachments(!getSendDiffFileAttachments()); refreshTopicKeyboard = true; break;
          case SETTINGS_ASSISTANT_FOOTER_CALLBACK: setShowAssistantRunFooter(!getShowAssistantRunFooter()); refreshTopicKeyboard = true; break;
          case SETTINGS_PROMPT_QUEUE_CALLBACK: setPromptQueueEnabled(!getPromptQueueEnabled()); destination = buildNotificationsSettingsView; refreshTopicKeyboard = true; break;
          default: await ctx.answerCallbackQuery({ text: t("callback.processing_error") }); return true;
        }
        await ctx.answerCallbackQuery({ text: t("settings.saved") });
        await renderSettingsView(ctx, destination());
        const topic = getTopicRuntimeContext();
        if (refreshTopicKeyboard && getCurrentTopicSettings() && topic?.sessionId && topic.chatId) {
          await keyboardManager.sendKeyboardUpdate(topic.chatId, true, topic.sessionId);
        }
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
