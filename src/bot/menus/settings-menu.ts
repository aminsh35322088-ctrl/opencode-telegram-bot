import { InlineKeyboard } from "grammy";
import {
  getCompactOutputMode,
  getPromptQueueEnabled,
  getResponseStreamingMode,
  getSendDiffFileAttachments,
  getShowAssistantRunFooter,
  getShowThinkingContent,
  type ResponseStreamingMode,
} from "../../app/stores/settings-store.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { formatModelForButton } from "../../app/types/model.js";

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

export function formatBooleanSettingValue(enabled: boolean): string {
  return enabled ? "ON" : "OFF";
}

export function formatResponseStreamingModeValue(mode: ResponseStreamingMode): string {
  return mode === "draft" ? "Live draft" : "Live edit";
}

function settingButton(label: string, value: string, callback: string): string {
  return `${label}: ${value}`;
}

function buildSettingsBackButton(keyboard: InlineKeyboard): InlineKeyboard {
  return keyboard.text("← Settings", SETTINGS_BACK_CALLBACK);
}

export function buildSettingsMenuView(): { text: string; keyboard: InlineKeyboard } {
  const currentModel = getStoredModel();
  const modelLabel =
    currentModel.providerID && currentModel.modelID
      ? formatModelForButton(currentModel.providerID, currentModel.modelID)
      : "Not selected";

  return {
    text: "⚙️ Settings\n\nChoose a category to control the bot and the way model replies are presented.",
    keyboard: new InlineKeyboard()
      .text(`🤖 Model · ${modelLabel}`, SETTINGS_MODEL_CALLBACK)
      .row()
      .text("🎨 Appearance", SETTINGS_APPEARANCE_CALLBACK)
      .row()
      .text("🔔 Notifications", SETTINGS_NOTIFICATIONS_CALLBACK)
      .row()
      .text("🧠 Context", SETTINGS_CONTEXT_CALLBACK)
      .row()
      .text("🛠 Advanced", SETTINGS_ADVANCED_CALLBACK),
  };
}

export function buildAppearanceSettingsView(): { text: string; keyboard: InlineKeyboard } {
  const compact = getCompactOutputMode();
  const thinking = getShowThinkingContent();
  const streaming = getResponseStreamingMode();
  const footer = getShowAssistantRunFooter();
  const diff = getSendDiffFileAttachments();

  const keyboard = new InlineKeyboard()
    .text(settingButton("📦 Compact output", formatBooleanSettingValue(compact), SETTINGS_COMPACT_OUTPUT_CALLBACK))
    .row()
    .text(settingButton("🧠 Thinking details", formatBooleanSettingValue(thinking), SETTINGS_THINKING_CONTENT_CALLBACK))
    .row()
    .text(
      `✍️ Reply streaming: ${formatResponseStreamingModeValue(streaming)}`,
      SETTINGS_RESPONSE_STREAMING_CALLBACK,
    )
    .row()
    .text(settingButton("📊 Run footer", formatBooleanSettingValue(footer), SETTINGS_ASSISTANT_FOOTER_CALLBACK))
    .row()
    .text(settingButton("📎 Diff files", formatBooleanSettingValue(diff), SETTINGS_DIFF_FILES_CALLBACK));

  buildSettingsBackButton(keyboard);

  const recommendation = compact
    ? "Compact output is ON — tool noise is minimized and replies stay visually tight."
    : "Tip: turn Compact output ON for a cleaner mobile-first view.";

  return {
    text: `🎨 Appearance\n\nControl the visual density and presentation of model replies.\n\n✨ ${recommendation}`,
    keyboard,
  };
}

export function buildNotificationsSettingsView(): { text: string; keyboard: InlineKeyboard } {
  const queue = getPromptQueueEnabled();
  const keyboard = new InlineKeyboard().text(
    settingButton("📥 Prompt queue", formatBooleanSettingValue(queue), SETTINGS_PROMPT_QUEUE_CALLBACK),
  );
  buildSettingsBackButton(keyboard);

  return {
    text: "🔔 Notifications\n\nControl how incoming prompts are handled while another task is running.",
    keyboard,
  };
}

export function buildContextSettingsView(): { text: string; keyboard: InlineKeyboard } {
  return {
    text: "🧠 Context\n\nContext limits, compaction, and provider-side token budgets are controlled by OpenCode itself.\n\nThe Telegram UI only exposes presentation controls here, so it does not add an artificial token or cost limit.",
    keyboard: new InlineKeyboard().text("← Settings", SETTINGS_BACK_CALLBACK),
  };
}

export function buildAdvancedSettingsView(): { text: string; keyboard: InlineKeyboard } {
  return {
    text: "🛠 Advanced\n\nAdvanced connectivity and integration controls are grouped here, away from reply presentation settings.",
    keyboard: new InlineKeyboard()
      .text("🔌 API Providers", "provider:menu")
      .row()
      .text("🔗 Integrations", "integration:menu")
      .row()
      .text("← Settings", SETTINGS_BACK_CALLBACK),
  };
}
