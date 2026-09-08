import type { I18nKey } from "../../i18n/en.js";
import { t } from "../../i18n/index.js";

/** Public, user-facing Telegram commands. Advanced/internal handlers stay available without cluttering the command picker. */
export interface BotCommandDefinition {
  command: string;
  description: string;
}

interface BotCommandI18nDefinition {
  command: string;
  descriptionKey?: I18nKey;
  description?: string;
}

const COMMAND_DEFINITIONS: BotCommandI18nDefinition[] = [
  { command: "start", description: "🚀 Start bot & show bot/OpenCode versions" },
  { command: "update", description: "🔄 Check for bot/OpenCode updates" },
  { command: "all", description: "🧰 All integrated versions (use /all version info)" },
  { command: "help", description: "❓ Show help & available features" },
  { command: "status", description: "📡 Show server & session status" },
  { command: "settings", description: "⚙️ Configure bot settings" },
  { command: "topic_settings", description: "⚙️ Open AI Topic settings" },
  { command: "providers", description: "🔌 Manage AI providers" },
  { command: "rename", description: "🏷️ Rename the current session" },
  { command: "abort", description: "🛑 Stop the current task" },
  { command: "stop", description: "🛑 Alias for /abort" },
  { command: "pause", description: "⏸️ Pause the current AI Topic run" },
  { command: "resume", description: "▶️ Resume the paused AI Topic run" },
  { command: "model", description: "🧠 Open Model Center in the current AI Topic" },
  { command: "agent", description: "🤖 Open Agent selection in the current AI Topic" },
  { command: "variant", description: "💡 Open Variant selection in the current AI Topic" },
  { command: "context", description: "📊 Open Context controls in the current AI Topic" },
  { command: "compact", description: "📦 Toggle compact output mode in the current AI Topic" },
  { command: "delete_topic", description: "🗑️ Delete the current AI Topic" },
  { command: "image", description: "🎨 Generate an image with AI" },
  { command: "edit", description: "✨ Edit a photo with AI" },
];

export function getLocalizedBotCommands(): BotCommandDefinition[] {
  return COMMAND_DEFINITIONS.map(({ command, descriptionKey, description }) => ({
    command,
    description: description ?? t(descriptionKey!),
  }));
}

export const BOT_COMMANDS: BotCommandDefinition[] = getLocalizedBotCommands();
