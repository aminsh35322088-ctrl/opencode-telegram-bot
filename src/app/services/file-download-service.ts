import nodeFetch, { type RequestInit as NodeFetchRequestInit } from "node-fetch";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Api } from "grammy";
import { Agent as HttpsAgent } from "https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";

const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;
const DEFAULT_TELEGRAM_API_ROOT = "https://api.telegram.org";

export interface DownloadedFile {
  buffer: Buffer;
  filePath: string;
  mimeType?: string;
}

function telegramFileUrlBase(): string {
  const apiRoot = config.telegram.apiRoot
    ? config.telegram.apiRoot.replace(/\/+$/, "")
    : DEFAULT_TELEGRAM_API_ROOT;

  return `${apiRoot}/file/bot`;
}

export function buildTelegramFileUrl(filePath: string): string {
  if (path.isAbsolute(filePath)) throw new Error("Telegram returned a local file path; use the configured local Bot API file reader.");
  const normalized = filePath.replaceAll("\\", "/");
  if (!normalized || normalized.split("/").some((part) => part === "..") || normalized.startsWith("/")) {
    throw new Error("Telegram returned an invalid file path.");
  }
  return `${telegramFileUrlBase()}${config.telegram.token}/${normalized.split("/").map(encodeURIComponent).join("/")}`;
}

function buildTelegramFetchOptions(options?: { signal?: AbortSignal; maxBytes?: number }): NodeFetchRequestInit {
  const maxBytes = options?.maxBytes ?? MAX_FILE_SIZE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_FILE_SIZE_BYTES) throw new Error("Invalid Telegram download size limit.");
  const fetchOptions: NodeFetchRequestInit = {
    size: maxBytes,
    redirect: "error",
    signal: AbortSignal.any([...(options?.signal ? [options.signal] : []), AbortSignal.timeout(30_000)]),
  };
  if (config.telegram.proxyUrl) {
    // Keep both HTTP CONNECT and SOCKS proxies supported for all media handlers.
    // Use the same configured proxy for getFile and the actual file transfer.
    fetchOptions.agent = config.telegram.proxyUrl.startsWith("socks")
      ? new SocksProxyAgent(config.telegram.proxyUrl)
      : new HttpsProxyAgent(config.telegram.proxyUrl);
  } else if (config.telegram.forceIpv4) {
    fetchOptions.agent = new HttpsAgent({ family: 4, keepAlive: true });
  }
  if (config.telegram.proxySecret) fetchOptions.headers = { "X-Proxy-Secret": config.telegram.proxySecret };
  return fetchOptions;
}

async function readLocalBotApiFile(filePath: string, maxBytes: number): Promise<Buffer> {
  const apiRoot = config.telegram.apiRoot ? new URL(config.telegram.apiRoot) : null;
  const localHost = apiRoot && ["localhost", "127.0.0.1", "::1"].includes(apiRoot.hostname.replace(/^\[|\]$/gu, ""));
  if (!localHost || !path.isAbsolute(filePath)) throw new Error("Telegram returned an unsupported absolute file path.");
  const metadata = await fs.lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxBytes) throw new Error("Telegram local file is unavailable or too large.");
  const buffer = await fs.readFile(filePath);
  if (buffer.length > maxBytes) throw new Error("Telegram local file exceeds the configured size limit.");
  return buffer;
}

async function downloadTelegramFilePath(filePath: string, options?: { signal?: AbortSignal; maxBytes?: number }): Promise<DownloadedFile> {
  const maxBytes = options?.maxBytes ?? MAX_FILE_SIZE_BYTES;
  if (path.isAbsolute(filePath)) {
    const buffer = await readLocalBotApiFile(filePath, maxBytes);
    return { buffer, filePath };
  }
  const fileUrl = buildTelegramFileUrl(filePath);
  logger.debug(`[FileDownload] Downloading Telegram file path=${filePath}`);
  options?.signal?.throwIfAborted();
  const response = await nodeFetch(fileUrl, buildTelegramFetchOptions(options));
  if (!response.ok) throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    (response.body as unknown as { destroy?: () => void } | null)?.destroy?.();
    throw new Error(`File too large: ${(declaredLength / (1024 * 1024)).toFixed(2)}MB (max ${(maxBytes / (1024 * 1024)).toFixed(2)}MB)`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error(`Downloaded file exceeded the ${(maxBytes / (1024 * 1024)).toFixed(2)}MB limit.`);
  logger.debug(`[FileDownload] Downloaded ${buffer.length} bytes`);
  return { buffer, filePath };
}

export async function downloadTelegramFile(api: Api, fileId: string, options?: { signal?: AbortSignal; maxBytes?: number }): Promise<DownloadedFile> {
  logger.debug(`[FileDownload] Getting file info for fileId=${fileId}`);
  options?.signal?.throwIfAborted();
  const maxBytes = options?.maxBytes ?? MAX_FILE_SIZE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_FILE_SIZE_BYTES) throw new Error("Invalid Telegram download size limit.");
  const file = await api.getFile(fileId);
  if (!file.file_path) throw new Error("File path not available from Telegram");
  if (file.file_size !== undefined && file.file_size > maxBytes) {
    throw new Error(`File too large: ${(file.file_size / (1024 * 1024)).toFixed(2)}MB (max ${(maxBytes / (1024 * 1024)).toFixed(2)}MB)`);
  }
  return downloadTelegramFilePath(file.file_path, options);
}

export async function downloadTelegramFileById(fileId: string, options?: { signal?: AbortSignal; maxBytes?: number }): Promise<DownloadedFile> {
  const token = config.telegram.token;
  if (!token) throw new Error("Telegram bot token is not configured.");
  const apiRoot = config.telegram.apiRoot ? config.telegram.apiRoot.replace(/\/+$/u, "") : DEFAULT_TELEGRAM_API_ROOT;
  const response = await nodeFetch(`${apiRoot}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`, buildTelegramFetchOptions(options));
  if (!response.ok) throw new Error(`Telegram getFile failed: ${response.status} ${response.statusText}`);
  const payload = await response.json() as { ok?: boolean; result?: { file_path?: string; file_size?: number }; description?: string };
  if (payload.ok !== true || !payload.result?.file_path) throw new Error(payload.description || "Telegram getFile returned no file path.");
  const maxBytes = options?.maxBytes ?? MAX_FILE_SIZE_BYTES;
  if (payload.result.file_size !== undefined && payload.result.file_size > maxBytes) {
    throw new Error(`File too large: ${(payload.result.file_size / (1024 * 1024)).toFixed(2)}MB (max ${(maxBytes / (1024 * 1024)).toFixed(2)}MB)`);
  }
  return downloadTelegramFilePath(payload.result.file_path, options);
}

export function toDataUri(buffer: Buffer, mimeType: string): string {
  const base64 = buffer.toString("base64");
  return `data:${mimeType};base64,${base64}`;
}

export function isFileSizeAllowed(fileSize: number | undefined, maxSizeKb: number): boolean {
  if (!fileSize) {
    return true;
  }

  const maxBytes = maxSizeKb * 1024;
  return fileSize <= maxBytes;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

const APPLICATION_TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-yaml",
  "application/sql",
]);

const TEXT_FILE_EXTENSIONS = new Set([
  "svelte",
  "vue",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "txt",
  "xml",
  "csv",
  "tsv",
  "sql",
  "env",
  "lock",
  "conf",
  "properties",
  "tf",
  "go",
  "rs",
  "rb",
  "py",
  "java",
  "c",
  "cpp",
  "h",
  "hpp",
  "cs",
  "swift",
  "kt",
  "kts",
  "sh",
  "bash",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "md",
  "mdx",
  "css",
  "scss",
  "less",
  "html",
  "htm",
  "graphql",
  "gql",
  "proto",
  "gradle",
]);

// Text files that carry no extension, plus dotfiles whose whole name is the marker.
const TEXT_FILE_NAMES = new Set([
  "makefile",
  "dockerfile",
  "license",
  "readme",
  "changelog",
  ".gitignore",
  ".dockerignore",
  ".editorconfig",
  ".env",
  ".env.example",
  ".npmrc",
  ".prettierrc",
  ".eslintrc",
]);

/**
 * Whether a local file looks like text, judging by its name alone.
 *
 * Files picked from the /ls browser carry no MIME type - Telegram only provides one for
 * uploaded documents - so `isTextMimeType` cannot be used for them.
 */
export function isTextFileName(filename: string): boolean {
  const baseName = filename.split(/[\\/]/).pop()?.toLowerCase();
  if (!baseName) {
    return false;
  }

  if (TEXT_FILE_NAMES.has(baseName)) {
    return true;
  }

  const ext = baseName.includes(".") ? baseName.split(".").pop() : undefined;
  return Boolean(ext && TEXT_FILE_EXTENSIONS.has(ext));
}

export function isTextMimeType(mimeType: string | undefined, filename?: string): boolean {
  if (!mimeType) {
    return false;
  }

  if (mimeType.startsWith("text/")) {
    return true;
  }

  if (APPLICATION_TEXT_MIME_TYPES.has(mimeType)) {
    return true;
  }

  if (filename) {
    const ext = filename.split(".").pop()?.toLowerCase();
    if (ext && TEXT_FILE_EXTENSIONS.has(ext)) {
      return true;
    }
  }

  return false;
}
