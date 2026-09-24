import type { McpStatus } from "@opencode-ai/sdk/v2";
import { InlineKeyboard } from "grammy";
import type { McpServerItem } from "../../app/services/mcp-server-service.js";
import { t } from "../../i18n/index.js";

export const MCPS_CALLBACK_PREFIX = "mcps:";
export const MCPS_CALLBACK_SELECT_PREFIX = `${MCPS_CALLBACK_PREFIX}select:`;
export const MCPS_CALLBACK_TOGGLE = `${MCPS_CALLBACK_PREFIX}toggle`;
export const MCPS_CALLBACK_RENAME = `${MCPS_CALLBACK_PREFIX}rename`;
export const MCPS_CALLBACK_RENAME_CANCEL = `${MCPS_CALLBACK_PREFIX}rename:cancel`;
export const MCPS_CALLBACK_DELETE = `${MCPS_CALLBACK_PREFIX}delete`;
export const MCPS_CALLBACK_DELETE_CONFIRM = `${MCPS_CALLBACK_PREFIX}delete:confirm`;
export const MCPS_CALLBACK_DELETE_CANCEL = `${MCPS_CALLBACK_PREFIX}delete:cancel`;
export const MCPS_CALLBACK_BACK = `${MCPS_CALLBACK_PREFIX}back`;
export const MCPS_CALLBACK_PARENT_BACK = `${MCPS_CALLBACK_PREFIX}parent_back`;
export const MCPS_CALLBACK_CANCEL = `${MCPS_CALLBACK_PREFIX}cancel`;
export const MCPS_CALLBACK_ADD = `${MCPS_CALLBACK_PREFIX}add`;
export const MCPS_CALLBACK_ADD_LOCAL = `${MCPS_CALLBACK_PREFIX}add:local`;
export const MCPS_CALLBACK_ADD_REMOTE = `${MCPS_CALLBACK_PREFIX}add:remote`;
export const MCPS_CALLBACK_ADD_BACK = `${MCPS_CALLBACK_PREFIX}add:back`;
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
function getTypeLabel(type: McpServerItem["type"]): string {
  if (type === "local") return t("mcps.type.local");
  if (type === "remote") return t("mcps.type.remote");
  return t("mcps.type.unknown");
}

function formatMcpButtonLabel(server: McpServerItem): string {
  const rawLabel =
    `${getStatusEmoji(server.status)} ${server.name} · ${getTypeLabel(server.type)}`;
  if (rawLabel.length <= MAX_INLINE_BUTTON_LABEL_LENGTH) return rawLabel;
  return `${rawLabel.slice(0, MAX_INLINE_BUTTON_LABEL_LENGTH - 3)}...`;
}
export function parseMcpSelectCallback(data: string): number | null {
  if (!data.startsWith(MCPS_CALLBACK_SELECT_PREFIX)) return null;
  const index = Number(data.slice(MCPS_CALLBACK_SELECT_PREFIX.length));
  if (!Number.isInteger(index) || index < 0) return null;
  return index;
}
export function buildMcpsListKeyboard(servers: McpServerItem[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  servers.forEach((server, index) => { keyboard.text(formatMcpButtonLabel(server), `${MCPS_CALLBACK_SELECT_PREFIX}${index}`).row(); });
  keyboard.text(t("mcps.button.add"), MCPS_CALLBACK_ADD).row();
  keyboard
    .text(t("mcps.button.back"), MCPS_CALLBACK_PARENT_BACK)
    .text(t("mcps.button.home"), "main:home");
  return keyboard;
}
export function buildMcpsEmptyKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(t("mcps.button.add"), MCPS_CALLBACK_ADD).row()
    .text(t("mcps.button.back"), MCPS_CALLBACK_PARENT_BACK)
    .text(t("mcps.button.home"), "main:home");
}
export function buildMcpsWizardKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(t("mcps.button.back"), MCPS_CALLBACK_CANCEL)
    .text(t("mcps.button.home"), "main:home");
}

export function buildMcpOAuthKeyboard(authorizationUrl: string): InlineKeyboard {
  return new InlineKeyboard()
    .url(t("mcps.button.open_login"), authorizationUrl).row()
    .text(t("mcps.button.back"), MCPS_CALLBACK_AUTH_CANCEL)
    .text(t("mcps.button.home"), "main:home");
}

export function buildMcpAuthOptionsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(t("mcps.button.auto_oauth"), MCPS_CALLBACK_AUTH_AUTO).row()
    .text(`🔑 ${t("mcps.auth.mode.bearer")}`, MCPS_CALLBACK_AUTH_BEARER)
    .text(`🗝 ${t("mcps.auth.mode.api_key")}`, MCPS_CALLBACK_AUTH_API_KEY).row()
    .text(`🧩 ${t("mcps.auth.mode.custom_header")}`, MCPS_CALLBACK_AUTH_CUSTOM_HEADER)
    .text(`🪪 ${t("mcps.auth.mode.oauth_client")}`, MCPS_CALLBACK_AUTH_CLIENT).row()
    .text(t("mcps.button.back"), MCPS_CALLBACK_AUTH_CANCEL)
    .text(t("mcps.button.home"), "main:home");
}

export function buildMcpCredentialInputKeyboard(options?: {
  allowSkip?: "secret" | "scope";
}): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (options?.allowSkip === "secret") {
    keyboard.text(t("mcps.button.skip_secret"), MCPS_CALLBACK_AUTH_SKIP_SECRET).row();
  }
  if (options?.allowSkip === "scope") {
    keyboard.text(t("mcps.button.skip_scope"), MCPS_CALLBACK_AUTH_SKIP_SCOPE).row();
  }
  keyboard
    .text(t("mcps.button.back"), MCPS_CALLBACK_AUTH_BACK)
    .text(t("mcps.button.cancel"), MCPS_CALLBACK_AUTH_CANCEL).row()
    .text(t("mcps.button.home"), "main:home");
  return keyboard;
}
export function buildMcpsAddTypeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(t("mcps.button.local"), MCPS_CALLBACK_ADD_LOCAL)
    .text(t("mcps.button.remote"), MCPS_CALLBACK_ADD_REMOTE).row()
    .text(t("mcps.button.back"), MCPS_CALLBACK_ADD_BACK)
    .text(t("mcps.button.cancel"), MCPS_CALLBACK_CANCEL).row()
    .text(t("mcps.button.home"), "main:home");
}

export function buildMcpsAddValueKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(t("mcps.button.back"), MCPS_CALLBACK_ADD_BACK)
    .text(t("mcps.button.cancel"), MCPS_CALLBACK_CANCEL).row()
    .text(t("mcps.button.home"), "main:home");
}

export function buildMcpRenameKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(t("mcps.button.cancel"), MCPS_CALLBACK_RENAME_CANCEL)
    .text(t("mcps.button.home"), "main:home");
}

export function buildMcpDeleteConfirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(t("mcps.button.confirm_delete"), MCPS_CALLBACK_DELETE_CONFIRM).row()
    .text(t("mcps.button.back"), MCPS_CALLBACK_DELETE_CANCEL)
    .text(t("mcps.button.home"), "main:home");
}

export function buildMcpsDetailKeyboard(server: McpServerItem): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const supportsRemoteAuth = server.type !== "local";
  let hasActionRow = false;

  if (server.status.status === "connected") {
    // Authentication controls intentionally disappear once the server is connected.
    // The detail view shows non-secret account identity instead.
  } else if (server.status.status === "needs_auth" && supportsRemoteAuth) {
    keyboard.text(t("mcps.button.sign_in"), MCPS_CALLBACK_AUTH_START);
    keyboard.text(t("mcps.button.other_auth"), MCPS_CALLBACK_AUTH_OPTIONS);
    hasActionRow = true;
  } else if (server.status.status === "needs_client_registration" && supportsRemoteAuth) {
    keyboard.text(`🪪 ${t("mcps.auth.mode.oauth_client")}`, MCPS_CALLBACK_AUTH_CLIENT);
    hasActionRow = true;
  } else if (server.status.status === "disabled" || server.status.status === "failed") {
    keyboard.text(t("mcps.button.enable"), MCPS_CALLBACK_TOGGLE);
    if (supportsRemoteAuth) {
      keyboard.text(t("mcps.button.authentication"), MCPS_CALLBACK_AUTH_OPTIONS);
    }
    hasActionRow = true;
  }

  if (hasActionRow) keyboard.row();
  keyboard
    .text(t("mcps.button.rename"), MCPS_CALLBACK_RENAME)
    .text(t("mcps.button.delete"), MCPS_CALLBACK_DELETE).row();
  keyboard
    .text(t("mcps.button.back"), MCPS_CALLBACK_BACK)
    .text(t("mcps.button.home"), "main:home");
  return keyboard;
}
export function buildMcpsDetailText(server: McpServerItem): string {
  const lines: string[] = [];
  lines.push(t("mcps.detail.title", { name: server.name }));
  lines.push("");
  lines.push(t("mcps.detail.status", { status: getStatusLabel(server.status) }));
  lines.push(t("mcps.detail.type", { type: getTypeLabel(server.type) }));
  if (server.status.status === "failed" || server.status.status === "needs_client_registration") {
    lines.push(t("mcps.detail.error", { error: server.status.error }));
  }
  if (server.status.status === "needs_auth") {
    lines.push("");
    lines.push(t("mcps.detail.needs_auth_hint"));
  }
  if (server.status.status === "needs_client_registration") {
    lines.push("");
    lines.push(t("mcps.detail.needs_client_registration_hint"));
  }
  return lines.join("\n");
}