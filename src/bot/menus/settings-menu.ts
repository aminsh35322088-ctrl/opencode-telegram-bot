import { InlineKeyboard } from "grammy";
import { getCompactOutputMode, getCurrentTopicSettings, getMessageFormatMode, getPromptQueueEnabled, getResponseStreamingMode, getSendDiffFileAttachments, getShowAssistantRunFooter, getShowThinkingContent, getTopicDefaults, type MessageFormatMode, type ResponseStreamingMode } from "../../app/stores/settings-store.js";
import { keyboardManager } from "../keyboards/keyboard-manager.js";
import { INLINE_MENU_CANCEL_PREFIX } from "./inline-menu.js";

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
export const SETTINGS_DEFAULT_COMPACT_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}default_compact`;
export const SETTINGS_DEFAULT_THINKING_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}default_thinking`;
export const SETTINGS_DEFAULT_STREAMING_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}default_streaming`;
export const SETTINGS_DEFAULT_FORMAT_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}default_format`;
export const SETTINGS_DEFAULT_FOOTER_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}default_footer`;
export const SETTINGS_DEFAULT_DIFF_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}default_diff`;
export const SETTINGS_DEFAULT_QUEUE_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}default_queue`;
export const SETTINGS_MCP_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}mcp`;
export const SETTINGS_SKILLS_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}skills`;
export const SETTINGS_COMMANDS_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}commands`;
export const SETTINGS_BACK_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}back`;
export const SETTINGS_CLOSE_CALLBACK = `${INLINE_MENU_CANCEL_PREFIX}settings`;
export const SETTINGS_RESET_HISTORY_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}reset_history`;
export const SETTINGS_RESET_HISTORY_CONFIRM_CALLBACK = `${SETTINGS_RESET_HISTORY_CALLBACK}:confirm`;
export const SETTINGS_RESET_HISTORY_CANCEL_CALLBACK = `${SETTINGS_RESET_HISTORY_CALLBACK}:cancel`;
export const SETTINGS_FACTORY_RESET_CALLBACK = `${SETTINGS_CALLBACK_PREFIX}factory_reset`;
export const SETTINGS_FACTORY_RESET_CONFIRM_CALLBACK = `${SETTINGS_FACTORY_RESET_CALLBACK}:confirm`;
export const SETTINGS_FACTORY_RESET_CANCEL_CALLBACK = `${SETTINGS_FACTORY_RESET_CALLBACK}:cancel`;
export const SETTINGS_FACTORY_RESET_FINAL_CALLBACK = `${SETTINGS_FACTORY_RESET_CALLBACK}:final`;

export function formatBooleanSettingValue(enabled: boolean): string { return enabled ? "ON" : "OFF"; }
export function formatResponseStreamingModeValue(mode: ResponseStreamingMode): string { return mode === "draft" ? "Live draft" : "Live edit"; }
export function formatMessageFormatModeValue(mode: MessageFormatMode): string { return mode === "raw" ? "Raw" : "Markdown"; }

function settingButton(label: string, value: string): string { return `${label}: ${value}`; }
function backButton(callback = SETTINGS_BACK_CALLBACK): InlineKeyboard { return new InlineKeyboard().text("← Back", callback); }
function appendSettingsBackButton(keyboard: InlineKeyboard): InlineKeyboard { return keyboard.row().text("← Back", SETTINGS_BACK_CALLBACK); }
function formatTopicModel(): string {
  const model = getCurrentTopicSettings()?.model;
  return model ? `${model.providerID}/${model.modelID}` : "Inherited default";
}
function statusPill(enabled: boolean): string { return enabled ? "🟢 ON" : "⚪ OFF"; }

export function buildSettingsMenuView(): { text: string; keyboard: InlineKeyboard } {
  if (getCurrentTopicSettings()) {
    const model = formatTopicModel();
    const agent = getCurrentTopicSettings()?.agent ?? "Inherited default";
    const variant = getCurrentTopicSettings()?.variant ?? "Default";
    return {
      text: [
        "🧵 <b>Topic Settings</b>",
        "",
        "Fine-tune this Topic without changing other Topics or global defaults.",
        "",
        `🤖 <b>Model</b>  ${model}`,
        `🧑‍💻 <b>Agent</b>  ${agent}`,
        `🎛 <b>Variant</b>  ${variant}`,
        "💬 <b>Response</b>  Streaming, format, thinking, footer & files",
        `📥 <b>Prompt Queue</b>  ${statusPill(getPromptQueueEnabled())}`,
        "🧠 <b>Context</b>  Live usage and model-window health",
        "⚙️ <b>Advanced</b>  MCP, Skills, Commands and data controls",
      ].join("\n"),
      keyboard: new InlineKeyboard()
        .text(`🤖 Model · ${model}`, SETTINGS_MODEL_CALLBACK).row()
        .text(`🧑‍💻 Agent · ${agent}`, SETTINGS_AGENT_CALLBACK).row()
        .text(`🎛 Variant · ${variant}`, SETTINGS_VARIANT_CALLBACK).row()
        .text("💬 Response & Output", SETTINGS_APPEARANCE_CALLBACK).row()
        .text(`📥 Prompt Queue · ${formatBooleanSettingValue(getPromptQueueEnabled())}`, SETTINGS_NOTIFICATIONS_CALLBACK).row()
        .text("🧠 Context", SETTINGS_CONTEXT_CALLBACK).row()
        .text("⚙️ Advanced", SETTINGS_ADVANCED_CALLBACK).row()
        .text("✖ Close", SETTINGS_CLOSE_CALLBACK),
    };
  }

  return {
    text: [
      "⚙️ <b>Settings</b>",
      "",
      "Global configuration and defaults for the bot.",
      "",
      "🤖 <b>Default Model</b> · Used when a new Topic has no explicit model.",
      "🧩 <b>Topic Defaults</b> · Copied into newly created Topics.",
      "🔌 <b>Providers & Models</b> · Discover available coding providers.",
      "🔗 <b>Integrations</b> · Manage connected services.",
      "🧰 <b>Advanced</b> · OpenCode tools and destructive data controls.",
    ].join("\n"),
    keyboard: new InlineKeyboard()
      .text("🤖 Default Model", SETTINGS_MODEL_CALLBACK).row()
      .text("🧩 Topic Defaults", SETTINGS_TOPIC_DEFAULTS_CALLBACK).row()
      .text("🔌 Providers & Models", "provider:menu").row()
      .text("🔗 Integrations", "integration:menu").row()
      .text("🧰 Advanced", SETTINGS_ADVANCED_CALLBACK)
      .row()
      .text("✖ Close", SETTINGS_CLOSE_CALLBACK),
  };
}

export function buildTopicDefaultsSettingsView(): { text: string; keyboard: InlineKeyboard } {
  const defaults = getTopicDefaults();
  const keyboard = new InlineKeyboard()
    .text(settingButton("📦 Compact", formatBooleanSettingValue(defaults.compactOutputMode)), SETTINGS_DEFAULT_COMPACT_CALLBACK).row()
    .text(settingButton("🧠 Thinking", formatBooleanSettingValue(defaults.showThinkingContent)), SETTINGS_DEFAULT_THINKING_CALLBACK).row()
    .text(`✍️ Streaming · ${formatResponseStreamingModeValue(defaults.responseStreamingMode)}`, SETTINGS_DEFAULT_STREAMING_CALLBACK).row()
    .text(`📝 Format · ${formatMessageFormatModeValue(defaults.messageFormatMode)}`, SETTINGS_DEFAULT_FORMAT_CALLBACK).row()
    .text(settingButton("📊 Run footer", formatBooleanSettingValue(defaults.showAssistantRunFooter)), SETTINGS_DEFAULT_FOOTER_CALLBACK).row()
    .text(settingButton("📎 Diff files", formatBooleanSettingValue(defaults.sendDiffFileAttachments)), SETTINGS_DEFAULT_DIFF_CALLBACK).row()
    .text(settingButton("📥 Prompt queue", formatBooleanSettingValue(defaults.promptQueueEnabled)), SETTINGS_DEFAULT_QUEUE_CALLBACK);
  appendSettingsBackButton(keyboard);
  return {
    text: [
      "🧩 <b>Topic Defaults</b>",
      "",
      "These values are copied only when a new Topic is created. Existing Topics keep their own settings.",
      "",
      `📦 Compact output · ${formatBooleanSettingValue(defaults.compactOutputMode)} — reduce verbose response formatting.`,
      `🧠 Thinking details · ${formatBooleanSettingValue(defaults.showThinkingContent)} — include model reasoning/details when available.`,
      `✍️ Streaming · ${formatResponseStreamingModeValue(defaults.responseStreamingMode)} — choose live-edit or live-draft delivery.`,
      `📝 Message format · ${formatMessageFormatModeValue(defaults.messageFormatMode)} — choose Markdown or raw text.`,
      `📊 Run footer · ${formatBooleanSettingValue(defaults.showAssistantRunFooter)} — show completion/usage footer information.`,
      `📎 Diff files · ${formatBooleanSettingValue(defaults.sendDiffFileAttachments)} — attach generated diffs as files when applicable.`,
      `📥 Prompt queue · ${formatBooleanSettingValue(defaults.promptQueueEnabled)} — queue new prompts while a run is busy.`,
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
    .text(`✍️ Reply streaming · ${formatResponseStreamingModeValue(streaming)}`, SETTINGS_RESPONSE_STREAMING_CALLBACK).row()
    .text(`📝 Message format · ${formatMessageFormatModeValue(format)}`, SETTINGS_MESSAGE_FORMAT_CALLBACK).row()
    .text(settingButton("📊 Run footer", formatBooleanSettingValue(footer)), SETTINGS_ASSISTANT_FOOTER_CALLBACK).row()
    .text(settingButton("📎 Diff files", formatBooleanSettingValue(diff)), SETTINGS_DIFF_FILES_CALLBACK);
  appendSettingsBackButton(keyboard);
  return {
    text: [
      "💬 <b>Response & Output</b>",
      "",
      "Control exactly how this Topic receives and displays model responses.",
      "",
      `📦 <b>Compact output</b> · ${statusPill(compact)} — keeps responses less verbose when supported.`,
      `🧠 <b>Thinking details</b> · ${statusPill(thinking)} — show reasoning/thinking content when exposed by the provider.`,
      `✍️ <b>Reply streaming</b> · ${formatResponseStreamingModeValue(streaming)} — edit one live message or use a draft-style stream.`,
      `📝 <b>Message format</b> · ${formatMessageFormatModeValue(format)} — Markdown formatting or raw text.`,
      `📊 <b>Run footer</b> · ${statusPill(footer)} — append run completion/usage information.`,
      `📎 <b>Diff files</b> · ${statusPill(diff)} — send generated diff content as file attachments when available.`,
    ].join("\n"),
    keyboard,
  };
}

export function buildNotificationsSettingsView(): { text: string; keyboard: InlineKeyboard } {
  const queue = getPromptQueueEnabled();
  const keyboard = new InlineKeyboard().text(settingButton("📥 Prompt queue", formatBooleanSettingValue(queue)), SETTINGS_PROMPT_QUEUE_CALLBACK);
  appendSettingsBackButton(keyboard);
  return {
    text: [
      "📥 <b>Prompt Queue</b>",
      "",
      "Choose whether new prompts should wait instead of colliding with an active run.",
      "",
      `Current state: ${statusPill(queue)}`,
      "",
      "🟢 ON · new prompts are held in order until the current run is free.",
      "⚪ OFF · new prompts follow the normal busy/run handling path.",
    ].join("\n"),
    keyboard,
  };
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
    return {
      text: [
        "🧠 <b>Context Health</b>",
        "",
        "Shows the latest observed input-context usage for this Topic.",
        "",
        "⚪ <b>No usage observed yet.</b>",
        "Start a model run and return here to see the live context window estimate.",
      ].join("\n"),
      keyboard: backButton(),
    };
  }
  const percent = Math.max(0, Math.round((info.tokensUsed / info.tokensLimit) * 100));
  const health = percent < 60 ? "🟢 Healthy" : percent < 80 ? "🟡 Getting large" : percent < 95 ? "🟠 Nearly full" : "🔴 Critical";
  return {
    text: [
      "🧠 <b>Context Health</b>",
      "",
      "Live snapshot of the most recently observed model input context.",
      "",
      `${health} · ${percent}% used`,
      contextGauge(info.tokensUsed, info.tokensLimit),
      `<b>${info.tokensUsed.toLocaleString()}</b> / ${info.tokensLimit.toLocaleString()} tokens`,
      "",
      "📌 <b>Tokens used</b> · latest observed input context.",
      "📐 <b>Model window</b> · provider metadata when available.",
      "💡 A high percentage can increase trimming or compaction pressure.",
    ].join("\n"),
    keyboard: backButton(),
  };
}

export function buildAdvancedSettingsView(): { text: string; keyboard: InlineKeyboard } {
  const keyboard = new InlineKeyboard()
    .text("🔗 MCP Servers", SETTINGS_MCP_CALLBACK).row()
    .text("🧠 Skills", SETTINGS_SKILLS_CALLBACK).row()
    .text("🧩 Custom Commands", SETTINGS_COMMANDS_CALLBACK).row()
    .text("🧹 Clear Conversation History", SETTINGS_RESET_HISTORY_CALLBACK).row()
    .text("☢️ Factory Reset", SETTINGS_FACTORY_RESET_CALLBACK);
  appendSettingsBackButton(keyboard);
  return {
    text: [
      "⚙️ <b>Advanced</b>",
      "",
      "Tools and maintenance controls for this bot.",
      "",
      "🔗 <b>MCP Servers</b> · inspect and manage Model Context Protocol integrations.",
      "🧠 <b>Skills</b> · inspect available reusable skills.",
      "🧩 <b>Custom Commands</b> · inspect bot/OpenCode command definitions.",
      "🧹 <b>Clear Conversation History</b> · remove managed Topics and conversation state while keeping global configuration.",
      "☢️ <b>Factory Reset</b> · wipe managed data and saved bot configuration; source code/runtime remain intact.",
    ].join("\n"),
    keyboard,
  };
}

export function buildResetHistoryConfirmationView(): { text: string; keyboard: InlineKeyboard } {
  return {
    text: [
      "⚠️ <b>Clear All Conversation History?</b>",
      "",
      "This permanently removes all managed AI Topics, their OpenCode sessions, conversation memory, Topic runtime state, and bot-created Topic workspaces/files.",
      "",
      "✅ Providers, API keys, model/agent settings, Topic defaults and other global configuration stay intact.",
      "❌ This action cannot be undone.",
    ].join("\n"),
    keyboard: new InlineKeyboard()
      .text("✅ Clear All History", SETTINGS_RESET_HISTORY_CONFIRM_CALLBACK).row()
      .text("← Back", SETTINGS_RESET_HISTORY_CANCEL_CALLBACK),
  };
}

export function buildFactoryResetConfirmationView(): { text: string; keyboard: InlineKeyboard } {
  return {
    text: [
      "☢️ <b>Factory Reset</b>",
      "",
      "This removes all managed Topics, OpenCode sessions, memory, Topic runtime state, workspaces/files and saved bot configuration.",
      "",
      "🧹 Providers, API keys, model/agent selection, Topic defaults, permissions, scheduled tasks, integrations and persisted application data are reset.",
      "🛡 Source code and deployment/runtime configuration stay intact.",
      "❌ This action cannot be undone.",
    ].join("\n"),
    keyboard: new InlineKeyboard()
      .text("✅ Continue", SETTINGS_FACTORY_RESET_CONFIRM_CALLBACK).row()
      .text("← Back", SETTINGS_FACTORY_RESET_CANCEL_CALLBACK),
  };
}

export function buildFactoryResetFinalView(): { text: string; keyboard: InlineKeyboard } {
  return {
    text: [
      "🔴 <b>Final Factory Reset</b>",
      "",
      "You are one step away from returning the bot to a fresh application state.",
      "",
      "Managed Topics, sessions, persistent memory, Topic workspaces and saved configuration will be deleted.",
      "🛡 Source code and deployment/runtime configuration stay intact.",
      "",
      "Proceed only if you are certain.",
    ].join("\n"),
    keyboard: new InlineKeyboard()
      .text("🔴 Confirm Factory Reset", SETTINGS_FACTORY_RESET_FINAL_CALLBACK).row()
      .text("← Back", SETTINGS_FACTORY_RESET_CANCEL_CALLBACK),
  };
}
