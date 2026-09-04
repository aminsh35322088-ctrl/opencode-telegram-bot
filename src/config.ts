import dotenv from "dotenv";
import { getRuntimePaths } from "./runtime/paths.js";
import { normalizeLocale, type Locale } from "./i18n/index.js";

const runtimePaths = getRuntimePaths();
dotenv.config({ path: runtimePaths.envFilePath, quiet: true });

export type MessageFormatMode = "raw" | "markdown";
export type SttRequestFormat = "multipart" | "json";

function getRequiredTelegramEnvVar(key: "TELEGRAM_BOT_TOKEN" | "TELEGRAM_ALLOWED_USER_ID"): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function parseTelegramAllowedUserId(): number {
  const raw = getRequiredTelegramEnvVar("TELEGRAM_ALLOWED_USER_ID").trim();
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0 || String(id) !== raw) {
    throw new Error("TELEGRAM_ALLOWED_USER_ID must contain one valid positive Telegram user ID.");
  }
  return id;
}

const HARDCODED = {
  opencode: {
    apiUrl: "http://127.0.0.1:4096",
    username: "opencode",
    password: "",
    autoRestartEnabled: true,
    monitorIntervalSec: 60,
    modelProvider: "opencode",
    modelId: "big-pickle",
  },
  server: {
    logLevel: "info",
  },
  bot: {
    sessionsListLimit: 10,
    messagesListLimit: 10,
    projectsListLimit: 10,
    commandsListLimit: 10,
    modelsListLimit: 10,
    taskLimit: 10,
    scheduledTaskExecutionTimeoutMinutes: 120,
    scheduledTaskNotificationsSilent: false,
    bashToolDisplayMaxLength: 128,
    locale: normalizeLocale("en", "en" as Locale),
    trackBackgroundSessions: true,
    messageFormatMode: "markdown" as MessageFormatMode,
    messageMergeWindowMs: 1500,
    initialSettingsPreset: {} as Record<string, unknown>,
  },
  files: {
    maxFileSizeKb: 100,
  },
  open: {
    browserRoots: "/data/workspace",
  },
  stt: {
    apiUrl: "",
    apiKey: "",
    model: "whisper-large-v3-turbo",
    language: "",
    notePrompt: "",
    requestFormat: "multipart" as SttRequestFormat,
  },
  docExtractor: {
    apiUrl: "",
    apiKey: "",
  },
  media: {
    geminiApiKey: "",
    geminiImageModel: "gemini-3.1-flash-image",
  },
};

export function parseInitialSettingsPreset(): Record<string, unknown> {
  return { ...HARDCODED.bot.initialSettingsPreset };
}

export function buildTelegramConfig(): {
  token: string;
  allowedUserId: number;
  proxyUrl: string;
  apiRoot: string;
  proxySecret: string;
  forceIpv4: boolean;
} {
  return {
    token: getRequiredTelegramEnvVar("TELEGRAM_BOT_TOKEN"),
    allowedUserId: parseTelegramAllowedUserId(),
    proxyUrl: "",
    apiRoot: "",
    proxySecret: "",
    forceIpv4: false,
  };
}

export const config = {
  telegram: buildTelegramConfig(),
  opencode: {
    apiUrl: HARDCODED.opencode.apiUrl,
    username: HARDCODED.opencode.username,
    password: HARDCODED.opencode.password,
    autoRestartEnabled: HARDCODED.opencode.autoRestartEnabled,
    monitorIntervalSec: HARDCODED.opencode.monitorIntervalSec,
    model: {
      provider: HARDCODED.opencode.modelProvider,
      modelId: HARDCODED.opencode.modelId,
    },
  },
  server: HARDCODED.server,
  bot: HARDCODED.bot,
  files: HARDCODED.files,
  open: HARDCODED.open,
  stt: HARDCODED.stt,
  docExtractor: HARDCODED.docExtractor,
  media: HARDCODED.media,
};
