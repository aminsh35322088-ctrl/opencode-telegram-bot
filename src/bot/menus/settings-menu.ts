import { InlineKeyboard } from "grammy";
import {
  getCompactOutputMode,
  getCurrentTopicSettings,
  getMessageFormatMode,
  getPromptQueueEnabled,
  getResponseStreamingMode,
  getSendDiffFileAttachments,
  getShowAssistantRunFooter,
  getShowThinkingContent,
  type MessageFormatMode,
  type ResponseStreamingMode,
} from "../../app/stores/settings-store.js";
import { getTopicDefaults } from "../../app/stores/settings-store.js";
import { keyboardManager } from "../keyboards/keyboard-manager.js";

export const SETTINGS_CALLBACK_PREFIX = "settings:";
export const SETTINGS_MODEL_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}model`;
export const SETTINGS_APPEARANCE_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}appearance`;
export const SETTINGS_NOTIFICATIONS_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}notifications`;
export const SETTINGS_CONTEXT_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}context`;
export const SETTINGS_ADVANCED_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}advanced`;
export const SETTINGS_TOPIC_DEFAULTS_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}topic_defaults`;
export const SETTINGS_AGENT_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}agent`;
export const SETTINGS_VARIANT_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}variant`;
export const SETTINGS_COMPACT_OUTPUT_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}compact_output`;
export const SETTINGS_THINKING_CONTENT_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}thinking_content`;
export const SETTINGS_RESPONSE_STREAMING_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}response_streaming`;
export const SETTINGS_MESSAGE_FORMAT_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}message_format`;
export const SETTINGS_DIFF_FILES_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}diff_files`;
export const SETTINGS_ASSISTANT_FOOTER_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}assistant_footer`;
export const SETTINGS_PROMPT_QUEUE_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}prompt_queue`;
export const SETTINGS_MCP_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}mcp`;
export const SETTINGS_SKILLS_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}skills`;
export const SETTINGS_COMMANDS_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}commands`;
export const SETTINGS_BACK_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}back`;

export function formatBooleanSettingValue(enabled: boolean): string { return enabled ? "ON" : "OFF"; }
export function formatResponseStreamingModeValue(mode: ResponseStreamingMode): string { return mode === "draft" ? "Live draft" : "Live edit"; }
export function formatMessageFormatModeValue(mode: MessageFormatMode): string { return mode === "raw" ? "Raw" : "Markdown"; }
function settingButton(label: string, value: string): string { return `${label}: ${value}`; }
function appendSettingsBackButton(keyboard: InlineKeyboard, label = "← Settings"): void { keyboard.row().text(label, SETTINGS_BACK_CALLBACK); }

function formatTopicModel(): string {
  const settings = getCurrentTopicSettings();
  return settings?.model ? `${settings.model.providerID}/${settings.model.modelID}` : "Inherited default";
}

export function buildSettingsMenuView(): { text: string; keyboard: InlineKeyboard } {
  const isTopic = Boolean(getCurrentTopicSettings());
  if (isTopic) {
    return {
      text: "🧵 Topic Settings\n\nEverything on this page belongs only to the current Topic. Changing another Topic cannot mutate these values.",
      keyboard: new InlineKeyboard()
        .text(`🤖 Model: ${formatTopicModel()}`, SETTINGS_MODEL_CALLBACK).row()
        .text("🧑‍💻 Agent", SETTINGS_AGENT_CALLBACK)
        .text("🎛 Variant", SETTINGS_VARIANT_CALLBACK).row()
        .text("🎨 Reply & Output", SETTINGS_APPEARANCE_CALLBACK).row()
        .text("📥 Prompt Queue", SETTINGS_NOTIFICATIONS_CALLBACK).row()
        .text("🧠 Context", SETTINGS_CONTEXT_CALLBACK),
    };
  }

  return {
    text: "⚙️ Main Settings\n\nGlobal configuration for the bot, providers, integrations, and Topic creation defaults.",
    keyboard: new InlineKeyboard()
      .text("🤖 Default Model", SETTINGS_MODEL_CALLBACK).row()
      .text("🧩 Topic Defaults", SETTINGS_TOPIC_DEFAULTS_CALLBACK).row()
      .text("🔌 Providers & Models", "provider:menu").row()
      .text("🔗 Integrations", "integration:menu").row()
      .text("🧰 Advanced", SETTINGS_ADVANCED_CALLBACK),
  };
}

export function buildTopicDefaultsSettingsView(): { text: string; keyboard: InlineKeyboard } {
  const defaults = getTopicDefaults();
  const keyboard = new InlineKeyboard()
    .text(settingButton("📦 Compact", formatBooleanSettingValue(defaults.compactOutputMode)), SETTINGS_COMPACT_OUTPUT_CALLBACK).row()
    .text(settingButton("🧠 Thinking", formatBooleanSettingValue(defaults.showThinkingContent)), SETTINGS_THINKING_CONTENT_CALLBACK).row()
    .text(`✍️ Streaming: ${formatResponseStreamingModeValue(defaults.responseStreamingMode)}`, SETTINGS_RESPONSE_STREAMING_CALLBACK).row()
    .text(`📝 Format: ${formatMessageFormatModeValue(defaults.messageFormatMode)}`, SETTINGS_MESSAGE_FORMAT_CALLBACK).row()
    .text(settingButton("📊 Run footer", formatBooleanSettingValue(defaults.showAssistantRunFooter)), SETTINGS_ASSISTANT_FOOTER_CALLBACK).row()
    .text(settingButton("📎 Diff files", formatBooleanSettingValue(defaults.sendDiffFileAttachments)), SETTINGS_DIFF_FILES_CALLBACK).row()
    .text(settingButton("📥 Prompt queue", formatBooleanSettingValue(defaults.promptQueueEnabled)), SETTINGS_PROMPT_QUEUE_CALLBACK);
  appendSettingsBackButton(keyboard);
  return {
    text: [
      "🧩 Topic Defaults",
      "",
      "These values are copied into a Topic only when that Topic is created.",
      "Changing defaults later never mutates existing Topics.",
      "",
      `📦 Compact — ${defaults.compactOutputMode ? "ON" : "OFF"}`,
      `🧠 Thinking — ${defaults.showThinkingContent ? "ON" : "OFF"}`,
      `✍️ Streaming — ${formatResponseStreamingModeValue(defaults.responseStreamingMode)}`,
      `📝 Format — ${formatMessageFormatModeValue(defaults.messageFormatMode)}`,
      `📊 Run footer — ${defaults.showAssistantRunFooter ? "ON" : "OFF"}`,
      `📎 Diff files — ${defaults.sendDiffFileAttachments ? "ON" : "OFF"}`,
      `📥 Prompt queue — ${defaults.promptQueueEnabled ? "ON" : "OFF"}`,
    ].join("\n"),
    keyboard,
  };
}

export function buildAppearanceSettingsView(): { text: string; keyboard: InlineKeyboard } {
  const compact = getCompactOutputMode();
  const thinking = getShowThinkingContent();
  const streaming = getResponseStreamingMode();
  const format = getMessageFormatMode();
  const footer = getShowAssistantRunFooter();
  const diff = getSendDiffFileAttachments();
  const keyboard = new InlineKeyboard()
    .text(settingButton("📦 Compact output", formatBooleanSettingValue(compact)), SETTINGS_COMPACT_OUTPUT_CALLBACK).row()
    .text(settingButton("🧠 Thinking details", formatBooleanSettingValue(thinking)), SETTINGS_THINKING_CONTENT_CALLBACK).row()
    .text(`✍️ Reply streaming: ${formatResponseStreamingModeValue(streaming)}`, SETTINGS_RESPONSE_STREAMING_CALLBACK).row()
    .text(`📝 Message format: ${formatMessageFormatModeValue(format)}`, SETTINGS_MESSAGE_FORMAT_CALLBACK).row()
    .text(settingButton("📊 Run footer", formatBooleanSettingValue(footer)), SETTINGS_ASSISTANT_FOOTER_CALLBACK).row()
    .text(settingButton("📎 Diff files", formatBooleanSettingValue(diff)), SETTINGS_DIFF_FILES_CALLBACK);
  appendSettingsBackButton(keyboard);
  return {
    text: [
      "🎨 Reply & Output",
      "",
      "These settings apply only to the current Topic.",
      "",
      `📦 Compact output — ${compact ? "ON" : "OFF"}`,
      `🧠 Thinking details — ${thinking ? "ON" : "OFF"}`,
      `✍️ Reply streaming — ${formatResponseStreamingModeValue(streaming)}`,
      `📝 Message format — ${formatMessageFormatModeValue(format)}`,
      `📊 Run footer — ${footer ? "ON" : "OFF"}`,
      `📎 Diff files — ${diff ? "ON" : "OFF"}`,
    ].join("\n"),
    keyboard,
  };
}

export function buildNotificationsSettingsView(): { text: string; keyboard: InlineKeyboard } {
  const queue = getPromptQueueEnabled();
  const keyboard = new InlineKeyboard().text(settingButton("📥 Prompt queue", formatBooleanSettingValue(queue)), SETTINGS_PROMPT_QUEUE_CALLBACK);
  appendSettingsBackButton(keyboard);
  return { text: "📥 Prompt Queue\n\nThis queue belongs only to the current Topic.", keyboard };
}

function contextGauge(tokensUsed: number, tokensLimit: number): string {
  if (!tokensLimit || tokensLimit <= 0) return "░░░░░░░░░░░░░░░░░░░░  Unknown";
  const percent = Math.max(0, Math.min(100, Math.round((tokensUsed / tokensLimit) * 100)));
  const filled = Math.round(percent / 5);
  return `${"█".repeat(filled)}${"░".repeat(20 - filled)}  ${percent}%`;
}

export function buildContextSettingsView(): { text: string; keyboard: InlineKeyboard } {
  const info = keyboardManager.getContextInfo();
  if (!info || info.tokensLimit <= 0) return {
    text: "🧠 Context\n\nNo observed context usage is available yet.",
    keyboard: new InlineKeyboard().text("← Settings", SETTINGS_BACK_CALLBACK),
  };
  const percent = Math.round((info.tokensUsed / info.tokensLimit) * 100);
  const health = percent < 60 ? "🟢 Healthy" : percent < 80 ? "🟡 Getting large" : percent < 95 ? "🟠 Nearly full" : "🔴 Critical";
  return {
    text: ["🧠 Context", "", health, "", contextGauge(info.tokensUsed, info.tokensLimit), `${info.tokensUsed.toLocaleString()} / ${info.tokensLimit.toLocaleString()} tokens`, "", "📌 Latest observed input context.", "📐 Model window from provider metadata when available."].join("\n"),
    keyboard: new InlineKeyboard().text("← Settings", SETTINGS_BACK_CALLBACK),
  };
}

export function buildAdvancedSettingsView(): { text: string; keyboard: InlineKeyboard } {
  const keyboard = new InlineKeyboard()
    .text("🔌 API Providers", "provider:menu").row()
    .text("🔗 Integrations", "integration:menu").row()
    .text("🔗 MCP Servers", SETTINGS_MCP_CALLBACK).row()
    .text("🧠 Skills", SETTINGS_SKILLS_CALLBACK).row()
    .text("🧩 Custom Commands", SETTINGS_COMMANDS_CALLBACK);
  appendSettingsBackButton(keyboard);
  return {
    text: "🛠 Advanced\n\nGlobal integrations and OpenCode configuration.",
    keyboard,
  };
}
