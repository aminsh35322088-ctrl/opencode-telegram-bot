import type { I18nKey } from "../../i18n/en.js";
import { t } from "../../i18n/index.js";

/** Public, user-facing Telegram commands. Internal/debug handlers are intentionally omitted. */
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
  { command: "start", description: "🚀 Start bot & show OpenCode version" },
  { command: "update", description: "🔄 Check for a newer OpenCode version" },
  { command: "help", description: "❓ Show help & available features" },
  { command: "status", description: "📡 Show server & session status" },
  { command: "sessions", description: "🕘 Browse saved sessions" },
  { command: "messages", description: "🧾 Browse messages in the current session" },
  { command: "settings", description: "⚙️ Configure bot settings" },
  { command: "providers", description: "🔌 Manage AI providers" },
  { command: "rename", description: "🏷️ Rename the current session" },
  { command: "abort", description: "🛑 Stop the current task" },
  { command: "commands", description: "🧩 Browse custom OpenCode commands" },
  { command: "skills", description: "🧠 Browse OpenCode skills" },
  { command: "mcps", description: "🔗 Browse MCP servers" },
];

export function getLocalizedBotCommands(): BotCommandDefinition[] {
  return COMMAND_DEFINITIONS.map(({ command, descriptionKey, description }) => ({
    command,
    description: description ?? t(descriptionKey!),
  }));
}

export const BOT_COMMANDS: BotCommandDefinition[] = getLocalizedBotCommands();
