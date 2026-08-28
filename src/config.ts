import dotenv from "dotenv";
import { getRuntimePaths } from "./runtime/paths.js";
import { normalizeLocale, type Locale } from "./i18n/index.js";

const runtimePaths = getRuntimePaths();
dotenv.config({ path: runtimePaths.envFilePath, quiet: true });

export type MessageFormatMode = "raw" | "markdown";
export type TtsProvider = "openai" | "google" | "elevenlabs" | "edge";
export type SttRequestFormat = "multipart" | "json";

function getEnvVar(key: string, required: boolean = true): string {
  const value = process.env[key];
  if (required && !value) throw new Error(`Missing required environment variable: ${key} (expected in ${runtimePaths.envFilePath})`);
  return value || "";
}
function getOptionalPositiveIntEnvVar(key: string, defaultValue: number): number {
  const value = getEnvVar(key, false); if (!value) return defaultValue;
  const parsed = Number.parseInt(value, 10); return Number.isNaN(parsed) || parsed <= 0 ? defaultValue : parsed;
}
function getOptionalNonNegativeIntEnvVar(key: string, defaultValue: number): number {
  const value = getEnvVar(key, false); if (!value) return defaultValue;
  const parsed = Number.parseInt(value, 10); return Number.isNaN(parsed) || parsed < 0 ? defaultValue : parsed;
}
function getOptionalLocaleEnvVar(key: string, defaultValue: Locale): Locale { return normalizeLocale(getEnvVar(key, false), defaultValue); }
function getOptionalBooleanEnvVar(key: string, defaultValue: boolean): boolean {
  const value = getEnvVar(key, false).trim().toLowerCase();
  if (!value) return defaultValue;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return defaultValue;
}
function getOptionalMessageFormatModeEnvVar(key: string, defaultValue: MessageFormatMode): MessageFormatMode {
  const value = getEnvVar(key, false).trim().toLowerCase(); return value === "raw" || value === "markdown" ? value : defaultValue;
}
export function parseInitialSettingsPreset(): Record<string, unknown> {
  const raw = getEnvVar("INITIAL_SETTINGS_PRESET", false).trim(); if (!raw) return {};
  let parsed: unknown; try { parsed = JSON.parse(raw); } catch { throw new Error("INITIAL_SETTINGS_PRESET contains invalid JSON. Fix or unset the variable."); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("INITIAL_SETTINGS_PRESET must be a JSON object.");
  return parsed as Record<string, unknown>;
}
const VALID_TTS_PROVIDERS: TtsProvider[] = ["openai", "google", "elevenlabs", "edge"];
function getOptionalTtsProviderEnvVar(key: string, defaultValue: TtsProvider): TtsProvider {
  const value = getEnvVar(key, false).trim().toLowerCase(); return VALID_TTS_PROVIDERS.includes(value as TtsProvider) ? (value as TtsProvider) : defaultValue;
}
const VALID_STT_REQUEST_FORMATS: SttRequestFormat[] = ["multipart", "json"];
function getOptionalSttRequestFormatEnvVar(key: string, defaultValue: SttRequestFormat): SttRequestFormat {
  const value = getEnvVar(key, false).trim().toLowerCase(); return VALID_STT_REQUEST_FORMATS.includes(value as SttRequestFormat) ? (value as SttRequestFormat) : defaultValue;
}
export function buildTelegramConfig(): { token: string; allowedUserId: number; proxyUrl: string; apiRoot: string; proxySecret: string; forceIpv4: boolean } {
  const proxyUrl = getEnvVar("TELEGRAM_PROXY_URL", false); const apiRoot = getEnvVar("TELEGRAM_API_ROOT", false).replace(/\/+$/, ""); const proxySecret = getEnvVar("TELEGRAM_PROXY_SECRET", false); const forceIpv4 = getOptionalBooleanEnvVar("TELEGRAM_FORCE_IPV4", false);
  if (proxyUrl && apiRoot) throw new Error("TELEGRAM_PROXY_URL and TELEGRAM_API_ROOT are alternative connectivity modes and cannot be used together. Pick one.");
  if (proxySecret && !apiRoot) throw new Error("TELEGRAM_PROXY_SECRET requires TELEGRAM_API_ROOT to be set. Without a custom API root, the secret header would be sent to api.telegram.org.");
  return { token: getEnvVar("TELEGRAM_BOT_TOKEN"), allowedUserId: parseInt(getEnvVar("TELEGRAM_ALLOWED_USER_ID"), 10), proxyUrl, apiRoot, proxySecret, forceIpv4 };
}
export const config = {
  telegram: buildTelegramConfig(),
  opencode: {
    apiUrl: getEnvVar("OPENCODE_API_URL", false) || "http://localhost:4096",
    username: getEnvVar("OPENCODE_SERVER_USERNAME", false) || "opencode",
    password: getEnvVar("OPENCODE_SERVER_PASSWORD", false),
    autoRestartEnabled: getOptionalBooleanEnvVar("OPENCODE_AUTO_RESTART_ENABLED", false),
    monitorIntervalSec: getOptionalPositiveIntEnvVar("OPENCODE_MONITOR_INTERVAL_SEC", 300),
    model: {
      provider: getEnvVar("OPENCODE_MODEL_PROVIDER", false) || "glm-free",
      modelId: getEnvVar("OPENCODE_MODEL_ID", false) || "glm-5.3-flash",
    },
  },
  server: { logLevel: getEnvVar("LOG_LEVEL", false) || "info" },
  bot: {
    sessionsListLimit: getOptionalPositiveIntEnvVar("SESSIONS_LIST_LIMIT", 10),
    messagesListLimit: getOptionalPositiveIntEnvVar("MESSAGES_LIST_LIMIT", 10),
    projectsListLimit: getOptionalPositiveIntEnvVar("PROJECTS_LIST_LIMIT", 10),
    commandsListLimit: getOptionalPositiveIntEnvVar("COMMANDS_LIST_LIMIT", 10),
    modelsListLimit: getOptionalPositiveIntEnvVar("MODELS_LIST_LIMIT", 10),
    taskLimit: getOptionalPositiveIntEnvVar("TASK_LIMIT", 10),
    scheduledTaskExecutionTimeoutMinutes: getOptionalPositiveIntEnvVar("SCHEDULED_TASK_EXECUTION_TIMEOUT_MINUTES", 120),
    scheduledTaskNotificationsSilent: getOptionalBooleanEnvVar("SCHEDULED_TASK_DISABLE_NOTIFICATION", false),
    bashToolDisplayMaxLength: getOptionalPositiveIntEnvVar("BASH_TOOL_DISPLAY_MAX_LENGTH", 128),
    locale: getOptionalLocaleEnvVar("BOT_LOCALE", "en"),
    trackBackgroundSessions: getOptionalBooleanEnvVar("TRACK_BACKGROUND_SESSIONS", true),
    messageFormatMode: getOptionalMessageFormatModeEnvVar("MESSAGE_FORMAT_MODE", "markdown"),
    messageMergeWindowMs: getOptionalNonNegativeIntEnvVar("MESSAGE_MERGE_WINDOW_MS", 1500),
    initialSettingsPreset: parseInitialSettingsPreset(),
  },
  files: { maxFileSizeKb: parseInt(getEnvVar("CODE_FILE_MAX_SIZE_KB", false) || "100", 10) },
  open: { browserRoots: getEnvVar("OPEN_BROWSER_ROOTS", false) },
  stt: {
    apiUrl: getEnvVar("STT_API_URL", false), apiKey: getEnvVar("STT_API_KEY", false), model: getEnvVar("STT_MODEL", false) || "whisper-large-v3-turbo", language: getEnvVar("STT_LANGUAGE", false), notePrompt: getEnvVar("STT_NOTE_PROMPT", false), requestFormat: getOptionalSttRequestFormatEnvVar("STT_REQUEST_FORMAT", "multipart"),
  },
  docExtractor: { apiUrl: getEnvVar("DOC_EXTRACTOR_URL", false), apiKey: getEnvVar("DOC_EXTRACTOR_API_KEY", false) },
  tts: (() => {
    const provider = getOptionalTtsProviderEnvVar("TTS_PROVIDER", "openai");
    const defaultVoice = provider === "google" ? "en-US-Studio-O" : provider === "elevenlabs" ? "21m00Tcm4TlvDq8ikWAM" : provider === "edge" ? "en-US-EmmaMultilingualNeural" : "alloy";
    const defaultModel = provider === "elevenlabs" ? "eleven_flash_v2_5" : "gpt-4o-mini-tts";
    return { apiUrl: getEnvVar("TTS_API_URL", false), apiKey: getEnvVar("TTS_API_KEY", false), provider, model: getEnvVar("TTS_MODEL", false) || defaultModel, voice: getEnvVar("TTS_VOICE", false) || defaultVoice };
  })(),
};
