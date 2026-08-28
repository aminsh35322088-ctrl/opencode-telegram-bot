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
import { keyboardManager } from "../keyboards/keyboard-manager.js";

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
function settingButton(label: string, value: string): string { return `${label}: ${value}`; }
function appendSettingsBackButton(keyboard: InlineKeyboard): void { keyboard.row().text("← Settings", SETTINGS_BACK_CALLBACK); }

export function buildSettingsMenuView(): { text: string; keyboard: InlineKeyboard } {
  const currentModel = getStoredModel();
  const modelLabel = currentModel.providerID && currentModel.modelID ? formatModelForButton(currentModel.providerID, currentModel.modelID) : "Not selected";
  return { text: "⚙️ Settings\n\nTune the model, reply presentation, notifications, context display, and integrations.", keyboard: new InlineKeyboard().text(`🤖 Model\n${modelLabel}`, SETTINGS_MODEL_CALLBACK).row().text("🎨 Appearance", SETTINGS_APPEARANCE_CALLBACK).row().text("🔔 Notifications", SETTINGS_NOTIFICATIONS_CALLBACK).row().text("🧠 Context", SETTINGS_CONTEXT_CALLBACK).row().text("🛠 Advanced", SETTINGS_ADVANCED_CALLBACK) };
}

export function buildAppearanceSettingsView(): { text: string; keyboard: InlineKeyboard } {
  const compact = getCompactOutputMode();
  const thinking = getShowThinkingContent();
  const streaming = getResponseStreamingMode();
  const footer = getShowAssistantRunFooter();
  const diff = getSendDiffFileAttachments();
  const keyboard = new InlineKeyboard()
    .text(settingButton("📦 Compact output", formatBooleanSettingValue(compact)), SETTINGS_COMPACT_OUTPUT_CALLBACK).row()
    .text(settingButton("🧠 Thinking details", formatBooleanSettingValue(thinking)), SETTINGS_THINKING_CONTENT_CALLBACK).row()
    .text(`✍️ Reply streaming: ${formatResponseStreamingModeValue(streaming)}`, SETTINGS_RESPONSE_STREAMING_CALLBACK).row()
    .text(settingButton("📊 Run footer", formatBooleanSettingValue(footer)), SETTINGS_ASSISTANT_FOOTER_CALLBACK).row()
    .text(settingButton("📎 Diff files", formatBooleanSettingValue(diff)), SETTINGS_DIFF_FILES_CALLBACK);
  appendSettingsBackButton(keyboard);
  const compactDescription = compact ? "ON · tighter tool output, less visual noise, mobile-first formatting." : "OFF · full reply presentation is preserved.";
  return { text: ["🎨 Appearance", "", "Control how model replies look and stream in Telegram.", "", `📦 Compact output — ${compactDescription}`, `✍️ Streaming — ${formatResponseStreamingModeValue(streaming)}`, "", "These options change presentation only; they do not impose provider token or cost limits."].join("\n"), keyboard };
}

export function buildNotificationsSettingsView(): { text: string; keyboard: InlineKeyboard } {
  const queue = getPromptQueueEnabled();
  const keyboard = new InlineKeyboard().text(settingButton("📥 Prompt queue", formatBooleanSettingValue(queue)), SETTINGS_PROMPT_QUEUE_CALLBACK);
  appendSettingsBackButton(keyboard);
  return { text: "🔔 Notifications\n\nControl how incoming prompts are handled while another task is running.", keyboard };
}

function contextGauge(tokensUsed: number, tokensLimit: number): string {
  if (!tokensLimit || tokensLimit <= 0) return "░░░░░░░░░░░░░░░░░░░░  Unknown";
  const percent = Math.max(0, Math.min(100, Math.round((tokensUsed / tokensLimit) * 100)));
  const filled = Math.round(percent / 5);
  return `${"█".repeat(filled)}${"░".repeat(20 - filled)}  ${percent}%`;
}

export function buildContextSettingsView(): { text: string; keyboard: InlineKeyboard } {
  const info = keyboardManager.getContextInfo();
  if (!info || info.tokensLimit <= 0) {
    return { text: "🧠 Context\n\nNo active session context usage is available yet.\n\nStart a chat and this page will show the real context window usage reported by OpenCode/provider metadata.\n\nThe bot does not invent token limits or provider costs.", keyboard: new InlineKeyboard().text("← Settings", SETTINGS_BACK_CALLBACK) };
  }
  const percent = Math.round((info.tokensUsed / info.tokensLimit) * 100);
  const health = percent < 60 ? "🟢 Healthy" : percent < 80 ? "🟡 Getting large" : percent < 95 ? "🟠 Nearly full" : "🔴 Critical";
  return {
    text: [
      "🧠 Context",
      "",
      health,
      "",
      contextGauge(info.tokensUsed, info.tokensLimit),
      `${info.tokensUsed.toLocaleString()} / ${info.tokensLimit.toLocaleString()} tokens`,
      "",
      "📌 This is observed session context usage, not a billing estimate.",
      "🗜️ Compaction remains a presentation/execution strategy and never changes the provider's actual billing rules.",
    ].join("\n"),
    keyboard: new InlineKeyboard().text("← Settings", SETTINGS_BACK_CALLBACK),
  };
}

export function buildAdvancedSettingsView(): { text: string; keyboard: InlineKeyboard } {
  return { text: "🛠 Advanced\n\nAdvanced connectivity and integrations live here so the main reply settings stay clean.", keyboard: new InlineKeyboard().text("🔌 API Providers", "provider:menu").row().text("🔗 Integrations", "integration:menu").row().text("← Settings", SETTINGS_BACK_CALLBACK) };
}
