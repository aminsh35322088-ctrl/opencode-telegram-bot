import { InlineKeyboard } from "grammy";
import { getCompactOutputMode, getPromptQueueEnabled, getResponseStreamingMode, getSendDiffFileAttachments, getShowAssistantRunFooter, getShowThinkingContent, type ResponseStreamingMode } from "../../app/stores/settings-store.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { formatModelForButton } from "../../app/types/model.js";
import { t } from "../../i18n/index.js";

export const SETTINGS_CALLBACK_PREFIX = "settings:";
export const SETTINGS_APPEARANCE_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}appearance`;
export const SETTINGS_NOTIFICATIONS_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}notifications`;
export const SETTINGS_CONTEXT_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}context`;
export const SETTINGS_ADVANCED_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}advanced`;
export const SETTINGS_COMPACT_OUTPUT_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}compact_output`;
export const SETTINGS_THINKING_CONTENT_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}thinking_content`;
export const SETTINGS_RESPONSE_STREAMING_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}response_streaming`;
export const SETTINGS_DIFF_FILES_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}diff_files`;
export const SETTINGS_ASSISTANT_FOOTER_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}assistant_footer`;
export const SETTINGS_PROMPT_QUEUE_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}prompt_queue`;
export const SETTINGS_MODEL_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}model`;
export const SETTINGS_BACK_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}back`;

export function formatBooleanSettingValue(enabled: boolean): string { return enabled ? "ON" : "OFF"; }
export function formatResponseStreamingModeValue(mode: ResponseStreamingMode): string { return mode === "draft" ? "Live draft" : "Live edit"; }

function settingButton(label: string, value: string, callback: string): string {
  return `${label}: ${value}`;
}

export function buildSettingsMenuView(): { text: string; keyboard: InlineKeyboard } {
  const currentModel = getStoredModel();
  const modelLabel = currentModel.providerID && currentModel.modelID ? formatModelForButton(currentModel.providerID, currentModel.modelID) : "Not selected";
  const keyboard = new InlineKeyboard()
    .text(`🤖 Model · ${modelLabel}`, SETTINGS_MODEL_CALLBACK).row()
    .text("🎨 Appearance", SETTINGS_APPEARANCE_CALLBACK).row()
    .text("🔔 Notifications", SETTINGS_NOTIFICATIONS_CALLBACK).row()
    .text("🧠 Context", SETTINGS_CONTEXT_CALLBACK).row()
    .text("🛠 Advanced", SETTINGS_ADVANCED_CALLBACK);
  return { text: "⚙️ Settings\n\nConfigure how OpenCode behaves and how replies are presented.", keyboard };
}

export function buildAppearanceSettingsView(): { text: string; keyboard: InlineKeyboard } {
  const compact = getCompactOutputMode();
  const thinking = getShowThinkingContent();
  const streaming = getResponseStreamingMode();
  const footer = getShowAssistantRunFooter();
  const diff = getSendDiffFileAttachments();
  const keyboard = new InlineKeyboard()
    .text(settingButton("📦 Compact output", formatBooleanSettingValue(compact), SETTINGS_COMPACT_OUTPUT_CALLBACK)).row()
    .text(settingButton("🧠 Thinking details", formatBooleanSettingValue(thinking), SETTINGS_THINKING_CONTENT_CALLBACK)).row()
    .text(`✍️ Reply streaming · ${formatResponseStreamingModeValue(streaming)}`, SETTINGS_RESPONSE_STREAMING_CALLBACK).row()
    .text(settingButton("📊 Run footer", formatBooleanSettingValue(footer), SETTINGS_ASSISTANT_FOOTER_CALLBACK)).row()
    .text(settingButton("📎 Diff files", formatBooleanSettingValue(diff), SETTINGS_DIFF_FILES_CALLBACK)).row()
    .text("← Settings", SETTINGS_BACK_CALLBACK);
  return {
    text: "🎨 Appearance\n\nControl the visual density and presentation of model replies.\n\n✨ Recommended\nCompact output ON · Thinking details OFF · Live edit streaming",
    keyboard,
  };
}

export function buildNotificationsSettingsView(): { text: string; keyboard: InlineKeyboard } {
  const queue = getPromptQueueEnabled();
  return {
    text: "🔔 Notifications\n\nChoose how the bot behaves when work is busy or messages arrive while a task is running.",
    keyboard: new InlineKeyboard()
      .text(settingButton("📥 Prompt queue", formatBooleanSettingValue(queue), SETTINGS_PROMPT_QUEUE_CALLBACK)).row()
      .text("← Settings", SETTINGS_BACK_CALLBACK),
  };
}

export function buildContextSettingsView(): { text: string; keyboard: InlineKeyboard } {
  return {
    text: "🧠 Context\n\nContext is managed by OpenCode. The bot does not impose token budgets or provider-side cost limits.\n\nUse the controls below only for what is shown in Telegram.",
    keyboard: new InlineKeyboard().text("← Settings", SETTINGS_BACK_CALLBACK),
  };
}

export function buildAdvancedSettingsView(): { text: string; keyboard: InlineKeyboard } {
  return {
    text: "🛠 Advanced\n\nProvider and integration controls live here. These options affect connectivity rather than reply appearance.",
    keyboard: new InlineKeyboard()
      .text("🔌 API Providers", "provider:menu").row()
      .text("🔗 Integrations", "integration:menu").row()
      .text("← Settings", SETTINGS_BACK_CALLBACK),
  };
}
