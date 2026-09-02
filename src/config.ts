import dotenv from "dotenv";
import { getRuntimePaths } from "./runtime/paths.js";
import { normalizeLocale, type Locale } from "./i18n/index.js";

const runtimePaths = getRuntimePaths();
dotenv.config({ path: runtimePaths.envFilePath, quiet: true });

export type MessageFormatMode = "raw" | "markdown";
export type SttRequestFormat = "multipart" | "json";

function getEnvVar(key: string, required: boolean = true): string {
  const value = process.env[key];
  if (required && !value) throw new Error(`Missing required environment variable: ${key} (expected in ${runtimePaths.envFilePath})`);
  return value || "";
}
function getOptionalPositiveIntEnvVar(key: string, defaultValue: number): number {
  const value = getEnvVar(key, false); if (!value) return defaultValue;
  const parsedValue = Number.parseInt(value, 10); return Number.isNaN(parsedValue) || parsedValue <= 0 ? defaultValue : parsedValue;
}
function getOptionalNonNegativeIntEnvVar(key: string, defaultValue: number): number {
  const value = getEnvVar(key, false); if (!value) return defaultValue;
  const parsedValue = Number.parseInt(value, 10); return Number.isNaN(parsedValue) || parsedValue < 0 ? defaultValue : parsedValue;
}
function getOptionalLocaleEnvVar(key: string, defaultValue: Locale): Locale { return normalizeLocale(getEnvVar(key, false), defaultValue); }
function getOptionalBooleanEnvVar(key: string, defaultValue: boolean): boolean {
  const value = getEnvVar(key, false); if (!value) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}
function getOptionalMessageFormatModeEnvVar(key: string, defaultValue: MessageFormatMode): MessageFormatMode {
  const value = getEnvVar(key, false); if (!value) return defaultValue;
  const normalized = value.trim().toLowerCase(); return normalized === "raw" || normalized === "markdown" ? normalized : defaultValue;
}
function parseTelegramAllowedUserId(): number {
  const raw = getEnvVar("TELEGRAM_ALLOWED_USER_ID").trim();
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("TELEGRAM_ALLOWED_USER_ID must contain one valid positive Telegram user ID.");
  }
  return id;
}
export function parseInitialSettingsPreset(): Record<string, unknown> {
  const raw = getEnvVar("INITIAL_SETTINGS_PRESET", false).trim(); if (!raw) return {};
  let parsed: unknown; try { parsed = JSON.parse(raw); } catch { throw new Error("INITIAL_SETTINGS_PRESET contains invalid JSON. Fix or unset the variable."); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("INITIAL_SETTINGS_PRESET must be a JSON object.");
  return parsed as Record<string, unknown>;
}
const VALID_STT_REQUEST_FORMATS: SttRequestFormat[] = ["multipart", "json"];
function getOptionalSttRequestFormatEnvVar(key: string, defaultValue: SttRequestFormat): SttRequestFormat {
  const value = getEnvVar(key, false); if (!value) return defaultValue;
  const normalized = value.trim().toLowerCase(); return VALID_STT_REQUEST_FORMATS.includes(normalized as SttRequestFormat) ? normalized as SttRequestFormat : defaultValue;
}
export function buildTelegramConfig(): { token: string; allowedUserId: number; proxyUrl: string; apiRoot: string; proxySecret: string; forceIpv4: boolean } {
  const proxyUrl = getEnvVar("TELEGRAM_PROXY_URL", false);
  const apiRoot = getEnvVar("TELEGRAM_API_ROOT", false).replace(/\/+$/, "");
  const proxySecret = getEnvVar("TELEGRAM_PROXY_SECRET", false);
  const forceIpv4 = getOptionalBooleanEnvVar("TELEGRAM_FORCE_IPV4", false);
  const allowedUserId = parseTelegramAllowedUserId();
  if (proxyUrl && apiRoot) throw new Error("TELEGRAM_PROXY_URL and TELEGRAM_API_ROOT are alternative connectivity modes and cannot be used together. TELEGRAM_PROXY_URL tunnels TCP through a SOCKS/HTTP forward proxy; TELEGRAM_API_ROOT routes API calls through an HTTPS reverse proxy. Pick one.");
  if (proxySecret && !apiRoot) throw new Error("TELEGRAM_PROXY_SECRET requires TELEGRAM_API_ROOT to be set. Without a custom API root, the secret header would be sent to api.telegram.org.");
  return { token: getEnvVar("TELEGRAM_BOT_TOKEN"), allowedUserId, proxyUrl, apiRoot, proxySecret, forceIpv4 };
}
export const config = {
  telegram: buildTelegramConfig(),
  opencode: { apiUrl: getEnvVar("OPENCODE_API_URL", false) || "http://localhost:4096", username: getEnvVar("OPENCODE_SERVER_USERNAME", false) || "opencode", password: getEnvVar("OPENCODE_SERVER_PASSWORD", false), autoRestartEnabled: getOptionalBooleanEnvVar("OPENCODE_AUTO_RESTART_ENABLED", false), monitorIntervalSec: getOptionalPositiveIntEnvVar("OPENCODE_MONITOR_INTERVAL_SEC", 300), model: { provider: getEnvVar("OPENCODE_MODEL_PROVIDER", true), modelId: getEnvVar("OPENCODE_MODEL_ID", true) } },
  server: { logLevel: getEnvVar("LOG_LEVEL", false) || "info" },
  bot: { sessionsListLimit: getOptionalPositiveIntEnvVar("SESSIONS_LIST_LIMIT", 10), messagesListLimit: getOptionalPositiveIntEnvVar("MESSAGES_LIST_LIMIT", 10), projectsListLimit: getOptionalPositiveIntEnvVar("PROJECTS_LIST_LIMIT", 10), commandsListLimit: getOptionalPositiveIntEnvVar("COMMANDS_LIST_LIMIT", 10), modelsListLimit: getOptionalPositiveIntEnvVar("MODELS_LIST_LIMIT", 10), taskLimit: getOptionalPositiveIntEnvVar("TASK_LIMIT", 10), scheduledTaskExecutionTimeoutMinutes: getOptionalPositiveIntEnvVar("SCHEDULED_TASK_EXECUTION_TIMEOUT_MINUTES", 120), scheduledTaskNotificationsSilent: getOptionalBooleanEnvVar("SCHEDULED_TASK_DISABLE_NOTIFICATION", false), bashToolDisplayMaxLength: getOptionalPositiveIntEnvVar("BASH_TOOL_DISPLAY_MAX_LENGTH", 128), locale: getOptionalLocaleEnvVar("BOT_LOCALE", "en"), trackBackgroundSessions: getOptionalBooleanEnvVar("TRACK_BACKGROUND_SESSIONS", true), messageFormatMode: getOptionalMessageFormatModeEnvVar("MESSAGE_FORMAT_MODE", "markdown"), messageMergeWindowMs: getOptionalNonNegativeIntEnvVar("MESSAGE_MERGE_WINDOW_MS", 1500), initialSettingsPreset: parseInitialSettingsPreset() },
  files: { maxFileSizeKb: parseInt(getEnvVar("CODE_FILE_MAX_SIZE_KB", false) || "100", 10) },
  open: { browserRoots: getEnvVar("OPEN_BROWSER_ROOTS", false) },
  stt: { apiUrl: getEnvVar("STT_API_URL", false), apiKey: getEnvVar("STT_API_KEY", false), model: getEnvVar("STT_MODEL", false) || "whisper-large-v3-turbo", language: getEnvVar("STT_LANGUAGE", false), notePrompt: getEnvVar("STT_NOTE_PROMPT", false), requestFormat: getOptionalSttRequestFormatEnvVar("STT_REQUEST_FORMAT", "multipart") },
  docExtractor: { apiUrl: getEnvVar("DOC_EXTRACTOR_URL", false), apiKey: getEnvVar("DOC_EXTRACTOR_API_KEY", false) },
  media: { geminiApiKey: getEnvVar("GEMINI_API_KEY", false), geminiImageModel: getEnvVar("GEMINI_IMAGE_MODEL", false) || "gemini-3.1-flash-image" },
};
