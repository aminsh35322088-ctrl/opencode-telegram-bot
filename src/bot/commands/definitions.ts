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
  { command: "start", descriptionKey: "cmd.description.help" },
  { command: "update", description: "Check for a newer OpenCode version" },
  { command: "help", descriptionKey: "cmd.description.help" },
  { command: "status", descriptionKey: "cmd.description.status" },
  { command: "sessions", descriptionKey: "cmd.description.sessions" },
  { command: "messages", descriptionKey: "cmd.description.messages" },
  { command: "settings", descriptionKey: "cmd.description.settings" },
  { command: "providers", descriptionKey: "cmd.description.settings" },
  { command: "rename", descriptionKey: "cmd.description.rename" },
  { command: "abort", descriptionKey: "cmd.description.stop" },
  { command: "commands", descriptionKey: "cmd.description.commands" },
  { command: "skills", descriptionKey: "cmd.description.skills" },
  { command: "mcps", descriptionKey: "cmd.description.mcps" },
];

export function getLocalizedBotCommands(): BotCommandDefinition[] {
  return COMMAND_DEFINITIONS.map(({ command, descriptionKey, description }) => ({
    command,
    description: description ?? t(descriptionKey!),
  }));
}

export const BOT_COMMANDS: BotCommandDefinition[] = getLocalizedBotCommands();
