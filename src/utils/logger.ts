import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";
import { getRuntimeMode, type RuntimeMode } from "../runtime/mode.js";
import { getRuntimePaths } from "../runtime/paths.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const DEFAULT_LOG_LEVEL: LogLevel = "info";
const DEFAULT_LOG_RETENTION = 10;
const DEFAULT_LOG_MAX_MB = 12;
const DEFAULT_LOG_TOTAL_MAX_MB = 80;
const LOGGER_ERROR_PREFIX = "[LOGGER]";
const SESSION_DELTA_TRACE_MIN_INTERVAL_MS = 1000;

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let logStream: fs.WriteStream | null = null;
let logFilePath: string | null = null;
let initializePromise: Promise<void> | null = null;
let cleanupPromise: Promise<void> | null = null;
let streamErrorReported = false;
let logBytesWritten = 0;
let lastSessionDeltaTraceAt = 0;
let suppressedSessionDeltaTraceCount = 0;
const CONSOLE_BROKEN_KEY = "__opencodeTelegramBotConsoleOutputBroken";

function normalizeLogLevel(value: string): LogLevel {
  if (value in LOG_LEVELS) {
    return value as LogLevel;
  }

  return DEFAULT_LOG_LEVEL;
}

function parsePositiveInteger(value: string | undefined, defaultValue: number): number {
  if (!value) {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return defaultValue;
  }

  return parsed;
}

function getConfiguredLogLevel(): LogLevel {
  return normalizeLogLevel(process.env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL);
}

function getConfiguredLogRetention(): number {
  return parsePositiveInteger(process.env.LOG_RETENTION, DEFAULT_LOG_RETENTION);
}

function getConfiguredLogMaxBytes(): number {
  return parsePositiveInteger(process.env.LOG_MAX_MB, DEFAULT_LOG_MAX_MB) * 1024 * 1024;
}

function getConfiguredLogTotalMaxBytes(): number {
  return parsePositiveInteger(process.env.LOG_MAX_TOTAL_MB, DEFAULT_LOG_TOTAL_MAX_MB) * 1024 * 1024;
}

function formatPrefix(level: LogLevel): string {
  return `[${new Date().toISOString()}] [${level.toUpperCase()}]`;
}

function formatArg(arg: unknown): unknown {
  if (arg instanceof Error) {
    return arg.stack ?? `${arg.name}: ${arg.message}`;
  }

  return arg;
}

function formatArgForFile(arg: unknown): string {
  const formatted = formatArg(arg);

  if (typeof formatted === "string") {
    return formatted;
  }

  return inspect(formatted, {
    colors: false,
    compact: true,
    depth: 8,
    breakLength: Infinity,
  });
}

function withPrefix(level: LogLevel, args: unknown[]): unknown[] {
  const formattedArgs = args.map((arg) => formatArg(arg));
  const prefix = formatPrefix(level);

  if (formattedArgs.length === 0) {
    return [prefix];
  }

  if (typeof formattedArgs[0] === "string") {
    return [`${prefix} ${formattedArgs[0]}`, ...formattedArgs.slice(1)];
  }

  return [prefix, ...formattedArgs];
}

function formatLine(level: LogLevel, args: unknown[]): string {
  const prefix = formatPrefix(level);
  const formattedArgs = args.map((arg) => formatArgForFile(arg));

  if (formattedArgs.length === 0) {
    return prefix;
  }

  return `${prefix} ${formattedArgs.join(" ")}`;
}

function shouldLog(level: LogLevel): boolean {
  const configuredLevel = getConfiguredLogLevel();
  return LOG_LEVELS[level] >= LOG_LEVELS[configuredLevel];
}

function isHighFrequencySessionDeltaTrace(args: unknown[]): boolean {
  const first = args[0];
  if (typeof first !== "string") {
    return false;
  }

  return first.includes("[SessionTrace]") && first.includes("event=message.part.delta");
}

function shouldSuppressHighFrequencySessionDeltaTrace(args: unknown[]): boolean {
  if (!isHighFrequencySessionDeltaTrace(args)) {
    return false;
  }

  const now = Date.now();
  if (now - lastSessionDeltaTraceAt >= SESSION_DELTA_TRACE_MIN_INTERVAL_MS) {
    if (suppressedSessionDeltaTraceCount > 0) {
      args[0] = `${String(args[0])} suppressed=${suppressedSessionDeltaTraceCount}`;
      suppressedSessionDeltaTraceCount = 0;
    }
    lastSessionDeltaTraceAt = now;
    return false;
  }

  suppressedSessionDeltaTraceCount += 1;
  return true;
}

function sanitizeTimestampForFile(timestamp: string): string {
  return timestamp.replace(/:/g, "-").replace("T", "_");
}

function getSourcesLogFileName(): string {
  const timestamp = sanitizeTimestampForFile(new Date().toISOString().slice(0, 19));
  return `bot-${timestamp}_${process.pid}.log`;
}

function getInstalledLogFileName(): string {
  return `bot-${new Date().toISOString().slice(0, 10)}.log`;
}

function getLogFileName(mode: RuntimeMode): string {
  return mode === "installed" ? getInstalledLogFileName() : getSourcesLogFileName();
}

function getLogFilePathForMode(logsDirPath: string, mode: RuntimeMode): string {
  return path.join(logsDirPath, getLogFileName(mode));
}

function getLogFilePattern(mode: RuntimeMode): RegExp {
  // Retention also matches size-rotated "bot-<date>_<time>_<pid>[_n].log"
  // siblings and gzip-compressed archives so nothing can orphan on the volume.
  if (mode === "installed") {
    return /^bot-\d{4}-\d{2}-\d{2}(?:\.log|_\d{2}-\d{2}-\d{2}_\d+(?:_\d+)?\.log)(?:\.gz)?$/;
  }

  return /^bot-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_\d+(?:_\d+)?\.log(?:\.gz)?$/;
}

function reportLoggerInternalError(message: string, error?: unknown): void {
  if (isConsoleOutputBroken()) {
    return;
  }
  const details =
    error instanceof Error
      ? (error.stack ?? `${error.name}: ${error.message}`)
      : String(error ?? "");
  const suffix = details && details !== "undefined" ? ` ${details}` : "";
  process.stderr.write(`${formatPrefix("error")} ${LOGGER_ERROR_PREFIX} ${message}${suffix}\n`);
}

function isConsoleOutputBroken(): boolean {
  return (globalThis as Record<string, unknown>)[CONSOLE_BROKEN_KEY] === true;
}

const CONSOLE_PIPE_GUARD_KEY = "__opencodeTelegramBotConsolePipeGuardInstalled";

function installConsolePipeGuard(): void {
  if ((globalThis as Record<string, unknown>)[CONSOLE_PIPE_GUARD_KEY]) {
    return;
  }
  (globalThis as Record<string, unknown>)[CONSOLE_PIPE_GUARD_KEY] = true;

  const handleStreamError = (error: unknown): void => {
    if (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "EPIPE"
    ) {
      (globalThis as Record<string, unknown>)[CONSOLE_BROKEN_KEY] = true;
      return;
    }

    throw error;
  };

  process.stdout.on("error", handleStreamError);
  process.stderr.on("error", handleStreamError);
}

installConsolePipeGuard();

function handleLogStreamError(error: unknown): void {
  if (!streamErrorReported) {
    streamErrorReported = true;
    reportLoggerInternalError("Failed to write to log file.", error);
  }

  if (logStream) {
    logStream.destroy();
    logStream = null;
  }
}

function closeLogStream(): void {
  if (!logStream) {
    return;
  }

  logStream.removeAllListeners("error");
  logStream.end();
  logStream = null;
}

function ensureLogStream(filePath: string): void {
  if (logStream && logFilePath === filePath) {
    return;
  }

  closeLogStream();
  streamErrorReported = false;

  const stream = fs.createWriteStream(filePath, { flags: "a" });
  stream.on("error", handleLogStreamError);
  try {
    logBytesWritten = fs.statSync(filePath).size;
  } catch {
    logBytesWritten = 0;
  }

  logStream = stream;
  logFilePath = filePath;
}

async function cleanupOldLogs(logsDirPath: string, mode: RuntimeMode): Promise<void> {
  const retention = getConfiguredLogRetention();
  const filePattern = getLogFilePattern(mode);

  let fileNames: string[];

  try {
    fileNames = await fsPromises.readdir(logsDirPath);
  } catch (error) {
    reportLoggerInternalError(`Failed to read log directory ${logsDirPath}.`, error);
    return;
  }

  const matchingFiles = fileNames.filter((fileName) => filePattern.test(fileName)).sort();
  const filesToDelete = matchingFiles.slice(0, Math.max(0, matchingFiles.length - retention));

  // Second pass: even within the retention count, enforce a total-size budget
  // so long-lived deployments can never fill the persistent volume with logs.
  const totalMaxBytes = getConfiguredLogTotalMaxBytes();
  let retainedBytes = 0;
  const budgetRemovable: string[] = [];
  for (const fileName of matchingFiles.slice(Math.max(0, matchingFiles.length - retention))) {
    try {
      const stats = await fsPromises.stat(path.join(logsDirPath, fileName));
      retainedBytes += stats.size;
      if (retainedBytes > totalMaxBytes && fileName !== (logFilePath ? path.basename(logFilePath) : null)) {
        budgetRemovable.push(fileName);
      }
    } catch {
      // Missing or unreadable file: nothing to account for.
    }
  }
  filesToDelete.push(...budgetRemovable);

  await Promise.all(
    filesToDelete.map(async (fileName) => {
      try {
        await fsPromises.unlink(path.join(logsDirPath, fileName));
      } catch (error) {
        reportLoggerInternalError(`Failed to delete old log file ${fileName}.`, error);
      }
    }),
  );
}

function cleanupOldLogsInBackground(logsDirPath: string, mode: RuntimeMode): void {
  if (cleanupPromise) {
    return;
  }

  cleanupPromise = cleanupOldLogs(logsDirPath, mode)
    .catch((error) => {
      reportLoggerInternalError(`Failed to clean up old logs in ${logsDirPath}.`, error);
    })
    .finally(() => {
      cleanupPromise = null;
    });
}

function rotateInstalledLogIfNeeded(): void {
  const mode = getRuntimeMode();
  if (mode !== "installed" || !logFilePath) {
    return;
  }

  const runtimePaths = getRuntimePaths();
  const nextLogFilePath = getLogFilePathForMode(runtimePaths.logsDirPath, mode);
  if (logFilePath === nextLogFilePath) {
    return;
  }

  try {
    fs.mkdirSync(runtimePaths.logsDirPath, { recursive: true });
    fs.appendFileSync(nextLogFilePath, "");
    ensureLogStream(nextLogFilePath);
    cleanupOldLogsInBackground(runtimePaths.logsDirPath, mode);
  } catch (error) {
    reportLoggerInternalError(
      `Failed to rotate file logging to ${nextLogFilePath}.`,
      error,
    );
    closeLogStream();
    logFilePath = null;
  }
}

function rotateLogBySizeIfNeeded(): void {
  if (!logStream || !logFilePath) {
    return;
  }

  if (logBytesWritten < getConfiguredLogMaxBytes()) {
    return;
  }

  const mode = getRuntimeMode();
  const logsDirPath = path.dirname(logFilePath);
  const stamp = sanitizeTimestampForFile(new Date().toISOString().slice(0, 19));
  let rotatedPath = path.join(logsDirPath, `bot-${stamp}_${process.pid}.log`);
  let suffix = 1;
  while (fs.existsSync(rotatedPath)) {
    rotatedPath = path.join(logsDirPath, `bot-${stamp}_${process.pid}_${suffix}.log`);
    suffix += 1;
  }

  try {
    closeLogStream();
    fs.renameSync(logFilePath, rotatedPath);
    const nextLogFilePath = getLogFilePathForMode(logsDirPath, mode);
    fs.appendFileSync(nextLogFilePath, "");
    ensureLogStream(nextLogFilePath);
    cleanupOldLogsInBackground(logsDirPath, mode);
  } catch (error) {
    reportLoggerInternalError(`Failed to rotate oversized log ${logFilePath}.`, error);
    closeLogStream();
    logFilePath = null;
  }
}

function writeToFile(line: string): void {
  if (!logStream) {
    return;
  }

  try {
    rotateInstalledLogIfNeeded();
    if (!logStream) {
      return;
    }

    rotateLogBySizeIfNeeded();
    if (!logStream) {
      return;
    }

    logBytesWritten += Buffer.byteLength(line) + 1;
    logStream.write(`${line}\n`);
  } catch (error) {
    handleLogStreamError(error);
  }
}

async function initializeLoggerInternal(): Promise<void> {
  if (logStream && logFilePath) {
    return;
  }

  const runtimePaths = getRuntimePaths();
  const mode = getRuntimeMode();

  try {
    await fsPromises.mkdir(runtimePaths.logsDirPath, { recursive: true });
    const nextLogFilePath = getLogFilePathForMode(runtimePaths.logsDirPath, mode);
    await fsPromises.appendFile(nextLogFilePath, "");
    ensureLogStream(nextLogFilePath);
    await cleanupOldLogs(runtimePaths.logsDirPath, mode);
  } catch (error) {
    reportLoggerInternalError(
      `Failed to initialize file logging in ${runtimePaths.logsDirPath}.`,
      error,
    );
    closeLogStream();
    logFilePath = null;
  }
}

export async function initializeLogger(): Promise<void> {
  if (initializePromise) {
    await initializePromise;
    return;
  }

  initializePromise = initializeLoggerInternal();

  try {
    await initializePromise;
  } finally {
    initializePromise = null;
  }
}

export function getLogFilePath(): string | null {
  return logFilePath;
}

export async function flushLogger(): Promise<void> {
  if (cleanupPromise) {
    await cleanupPromise;
  }

  if (!logStream) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    logStream?.write("", (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

export async function __flushLoggerForTests(): Promise<void> {
  await flushLogger();
}

export function __resetLoggerForTests(): void {
  initializePromise = null;
  cleanupPromise = null;
  logFilePath = null;
  streamErrorReported = false;
  lastSessionDeltaTraceAt = 0;
  suppressedSessionDeltaTraceCount = 0;
  (globalThis as Record<string, unknown>)[CONSOLE_BROKEN_KEY] = false;
  closeLogStream();
}

function writeToConsole(level: LogLevel, args: unknown[]): void {
  if (isConsoleOutputBroken()) {
    return;
  }

  const prefixedArgs = withPrefix(level, args);
  if (level === "warn") {
    console.warn(...prefixedArgs);
  } else if (level === "error") {
    console.error(...prefixedArgs);
  } else {
    console.log(...prefixedArgs);
  }
}

export const logger = {
  debug: (...args: unknown[]): void => {
    if (shouldLog("debug")) {
      writeToConsole("debug", args);
      writeToFile(formatLine("debug", args));
    }
  },

  info: (...args: unknown[]): void => {
    if (shouldLog("info") && !shouldSuppressHighFrequencySessionDeltaTrace(args)) {
      writeToConsole("info", args);
      writeToFile(formatLine("info", args));
    }
  },

  warn: (...args: unknown[]): void => {
    if (shouldLog("warn")) {
      writeToConsole("warn", args);
      writeToFile(formatLine("warn", args));
    }
  },

  error: (...args: unknown[]): void => {
    if (shouldLog("error")) {
      writeToConsole("error", args);
      writeToFile(formatLine("error", args));
    }
  },
};
