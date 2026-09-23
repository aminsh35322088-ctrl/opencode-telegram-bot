import type { McpStatus } from "@opencode-ai/sdk/v2";
import { InlineKeyboard } from "grammy";
import type { McpCatalogServerItem } from "../../app/services/mcp-catalog-service.js";
import { t } from "../../i18n/index.js";

export const MCPS_CALLBACK_PREFIX = "mcps:";
export const MCPS_CALLBACK_SELECT_PREFIX = `${MCPS_CALLBACK_PREFIX}select:`;
export const MCPS_CALLBACK_TOGGLE = `${MCPS_CALLBACK_PREFIX}toggle`;
export const MCPS_CALLBACK_BACK = `${MCPS_CALLBACK_PREFIX}back`;
export const MCPS_CALLBACK_PARENT_BACK = `${MCPS_CALLBACK_PREFIX}parent_back`;
export const MCPS_CALLBACK_CANCEL = `${MCPS_CALLBACK_PREFIX}cancel`;
export const MCPS_CALLBACK_ADD = `${MCPS_CALLBACK_PREFIX}add`;
export const MCPS_CALLBACK_ADD_LOCAL = `${MCPS_CALLBACK_PREFIX}add:local`;
export const MCPS_CALLBACK_ADD_REMOTE = `${MCPS_CALLBACK_PREFIX}add:remote`;
export const MCPS_CALLBACK_AUTH_START = `${MCPS_CALLBACK_PREFIX}auth:start`;
export const MCPS_CALLBACK_AUTH_OPTIONS = `${MCPS_CALLBACK_PREFIX}auth:options`;
export const MCPS_CALLBACK_AUTH_CANCEL = `${MCPS_CALLBACK_PREFIX}auth:cancel`;
export const MCPS_CALLBACK_AUTH_BACK = `${MCPS_CALLBACK_PREFIX}auth:back`;
export const MCPS_CALLBACK_AUTH_AUTO = `${MCPS_CALLBACK_PREFIX}auth:auto`;
export const MCPS_CALLBACK_AUTH_BEARER = `${MCPS_CALLBACK_PREFIX}auth:bearer`;
export const MCPS_CALLBACK_AUTH_API_KEY = `${MCPS_CALLBACK_PREFIX}auth:api-key`;
export const MCPS_CALLBACK_AUTH_CUSTOM_HEADER = `${MCPS_CALLBACK_PREFIX}auth:custom`;
export const MCPS_CALLBACK_AUTH_CLIENT = `${MCPS_CALLBACK_PREFIX}auth:client`;
export const MCPS_CALLBACK_AUTH_SKIP_SECRET = `${MCPS_CALLBACK_PREFIX}auth:skip-secret`;
export const MCPS_CALLBACK_AUTH_SKIP_SCOPE = `${MCPS_CALLBACK_PREFIX}auth:skip-scope`;

const MAX_INLINE_BUTTON_LABEL_LENGTH = 64;

function getStatusLabel(status: McpStatus): string {
  switch (status.status) {
    case "connected": return t("mcps.status.connected");
    case "disabled": return t("mcps.status.disabled");
    case "failed": return t("mcps.status.failed");
    case "needs_auth": return t("mcps.status.needs_auth");
    case "needs_client_registration": return t("mcps.status.needs_client_registration");
    default: return t("common.unknown");
  }
}
function getStatusEmoji(status: McpStatus): string {
  switch (status.status) {
    case "connected": return "🟢";
    case "disabled": return "🔴";
    case "failed": return "⚠️";
    case "needs_auth": return "🔒";
    case "needs_client_registration": return "🔒";
    default: return "❓";
  }
}
function formatMcpButtonLabel(server: McpCatalogServerItem): string {
  const rawLabel = `${getStatusEmoji(server.status)} ${server.name}`;
  if (rawLabel.length <= MAX_INLINE_BUTTON_LABEL_LENGTH) return rawLabel;
  return `${rawLabel.slice(0, MAX_INLINE_BUTTON_LABEL_LENGTH - 3)}...`;
}
export function parseMcpSelectCallback(data: string): number | null {
  if (!data.startsWith(MCPS_CALLBACK_SELECT_PREFIX)) return null;
  const index = Number(data.slice(MCPS_CALLBACK_SELECT_PREFIX.length));
  if (!Number.isInteger(index) || index < 0) return null;
  return index;
}
export function buildMcpsListKeyboard(servers: McpCatalogServerItem[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  servers.forEach((server, index) => { keyboard.text(formatMcpButtonLabel(server), `${MCPS_CALLBACK_SELECT_PREFIX}${index}`).row(); });
  keyboard.text("➕ Add MCP Server", MCPS_CALLBACK_ADD).row();
  keyboard.text("← Back", MCPS_CALLBACK_PARENT_BACK).text("🏠 Home", "main:home");
  return keyboard;
}
export function buildMcpsEmptyKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("➕ Add MCP Server", MCPS_CALLBACK_ADD).row()
    .text("← Back", MCPS_CALLBACK_PARENT_BACK).text("🏠 Home", "main:home");
}
export function buildMcpsWizardKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("← MCP Servers", MCPS_CALLBACK_CANCEL)
    .text("🏠 Home", "main:home");
}

export function buildMcpOAuthKeyboard(authorizationUrl: string): InlineKeyboard {
  return new InlineKeyboard()
    .url("🔐 Open Login", authorizationUrl).row()
    .text("← Server", MCPS_CALLBACK_AUTH_CANCEL)
    .text("🏠 Home", "main:home");
}

export function buildMcpAuthOptionsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✨ Auto / OAuth", MCPS_CALLBACK_AUTH_AUTO).row()
    .text("🔑 Bearer Token", MCPS_CALLBACK_AUTH_BEARER)
    .text("🗝 API Key", MCPS_CALLBACK_AUTH_API_KEY).row()
    .text("🧩 Custom Header", MCPS_CALLBACK_AUTH_CUSTOM_HEADER)
    .text("🪪 OAuth Client", MCPS_CALLBACK_AUTH_CLIENT).row()
    .text("← Server", MCPS_CALLBACK_AUTH_CANCEL)
    .text("🏠 Home", "main:home");
}

export function buildMcpCredentialInputKeyboard(options?: {
  allowSkip?: "secret" | "scope";
}): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (options?.allowSkip === "secret") keyboard.text("Skip Secret", MCPS_CALLBACK_AUTH_SKIP_SECRET).row();
  if (options?.allowSkip === "scope") keyboard.text("Skip Scope", MCPS_CALLBACK_AUTH_SKIP_SCOPE).row();
  keyboard
    .text("← Back", MCPS_CALLBACK_AUTH_BACK)
    .text("✖ Cancel", MCPS_CALLBACK_AUTH_CANCEL).row()
    .text("🏠 Home", "main:home");
  return keyboard;
}
export function buildMcpsAddTypeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("💻 Local", MCPS_CALLBACK_ADD_LOCAL)
    .text("🌐 Remote", MCPS_CALLBACK_ADD_REMOTE).row()
    .text("← MCP Servers", MCPS_CALLBACK_CANCEL)
    .text("🏠 Home", "main:home");
}
export function buildMcpsDetailKeyboard(server: McpCatalogServerItem): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  let hasToggleButton = false;
  if (server.status.status === "connected") {
    keyboard.text(t("mcps.button.disable"), MCPS_CALLBACK_TOGGLE);
    keyboard.text("🔐 Auth", MCPS_CALLBACK_AUTH_OPTIONS);
    hasToggleButton = true;
  } else if (server.status.status === "needs_auth") {
    keyboard.text("🔐 Sign In", MCPS_CALLBACK_AUTH_START);
    keyboard.text("⚙️ Other Auth", MCPS_CALLBACK_AUTH_OPTIONS);
    hasToggleButton = true;
  } else if (server.status.status === "needs_client_registration") {
    keyboard.text("🪪 OAuth Client", MCPS_CALLBACK_AUTH_CLIENT);
    hasToggleButton = true;
  } else if (server.status.status === "disabled" || server.status.status === "failed") {
    keyboard.text(t("mcps.button.enable"), MCPS_CALLBACK_TOGGLE);
    keyboard.text("🔐 Authentication", MCPS_CALLBACK_AUTH_OPTIONS);
    hasToggleButton = true;
  }
  if (hasToggleButton) keyboard.row();
  keyboard.text(t("mcps.button.back"), MCPS_CALLBACK_BACK).text("🏠 Home", "main:home");
  return keyboard;
}
export function buildMcpsDetailText(server: McpCatalogServerItem): string {
  const lines: string[] = [];
  lines.push(t("mcps.detail.title", { name: server.name }));
  lines.push("");
  lines.push(t("mcps.detail.status", { status: getStatusLabel(server.status) }));
  if (server.status.status === "failed" || server.status.status === "needs_client_registration") {
    lines.push(t("mcps.detail.error", { error: server.status.error }));
  }
  if (server.status.status === "needs_auth") {
    lines.push("");
    lines.push("🔐 OAuth login is required. Tap Sign In below to authorize this MCP server.");
  }
  if (server.status.status === "needs_client_registration") {
    lines.push("");
    lines.push("🪪 This server requires a pre-registered OAuth client. Configure its Client ID and optional Client Secret here, then continue with Sign In.");
  }
  return lines.join("\n");
}