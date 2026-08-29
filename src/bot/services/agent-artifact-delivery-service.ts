import { promises as fs } from "node:fs";
import path from "node:path";
import { Bot, InputFile } from "grammy";
import { config } from "../../config.js";
import { createTelegramBotOptions } from "../telegram-client-options.js";
import { logger } from "../../utils/logger.js";
import type { Event } from "@opencode-ai/sdk/v2";

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
const DEBOUNCE_MS = 1500;
const DELIVERY_COOLDOWN_MS = 5000;

const BINARY_ARTIFACT_EXTENSIONS = new Set([
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".csv", ".zip", ".7z", ".tar", ".gz", ".tgz", ".bz2", ".xz",
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg", ".ico",
  ".mp4", ".mov", ".webm", ".mkv", ".avi", ".mp3", ".wav", ".m4a", ".flac",
  ".apk", ".ipa", ".exe", ".dmg", ".iso", ".sqlite", ".sqlite3", ".db", ".parquet",
]);

const TEXT_ARTIFACT_EXTENSIONS = new Set([
  ".md", ".txt", ".csv", ".json", ".xml", ".yaml", ".yml", ".html", ".htm",
  ".tex", ".log",
]);

const GENERATED_NAME_HINTS = [
  "output", "result", "report", "export", "artifact", "generated", "download",
  "final", "render", "screenshot", "image", "document", "presentation", "spreadsheet",
];

const IGNORED_PATH_SEGMENTS = new Set([
  ".git", "node_modules", ".opencode", ".tmp", "dist", "build", ".cache", ".next",
]);

function isIgnoredPath(filePath: string): boolean {
  return filePath
    .split(/[\\/]+/)
    .some((segment) => IGNORED_PATH_SEGMENTS.has(segment.toLowerCase()));
}

function extensionOf(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

function isLikelyArtifact(filePath: string): boolean {
  if (isIgnoredPath(filePath)) {
    return false;
  }

  const extension = extensionOf(filePath);
  if (BINARY_ARTIFACT_EXTENSIONS.has(extension)) {
    return true;
  }

  if (!TEXT_ARTIFACT_EXTENSIONS.has(extension)) {
    return false;
  }

  const name = path.basename(filePath, extension).toLowerCase();
  return GENERATED_NAME_HINTS.some((hint) => name.includes(hint));
}

function captionFor(filePath: string, size: number): string {
  const sizeMb = (size / (1024 * 1024)).toFixed(2);
  return `📎 ${path.basename(filePath)} · ${sizeMb} MB`;
}

class AgentArtifactDeliveryService {
  private readonly bot: Bot;
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastDelivered = new Map<string, { signature: string; at: number }>();

  constructor() {
    this.bot = new Bot(config.telegram.token, createTelegramBotOptions(config.telegram));
  }

  processEvent(event: Event): void {
    if (event.type !== "file.edited" && event.type !== "file.watcher.updated") {
      return;
    }

    const filePath = event.properties.file;
    if (typeof filePath !== "string" || !isLikelyArtifact(filePath)) {
      return;
    }

    if (event.type === "file.watcher.updated" && event.properties.event === "unlink") {
      return;
    }

    const previous = this.pending.get(filePath);
    if (previous) {
      clearTimeout(previous);
    }

    const timer = setTimeout(() => {
      this.pending.delete(filePath);
      void this.deliver(filePath);
    }, DEBOUNCE_MS);

    this.pending.set(filePath, timer);
  }

  clear(): void {
    for (const timer of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
    this.lastDelivered.clear();
  }

  private async deliver(filePath: string): Promise<void> {
    try {
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat?.isFile() || stat.size > MAX_FILE_SIZE_BYTES || stat.size === 0) {
        return;
      }

      const signature = `${stat.size}:${stat.mtimeMs}`;
      const previous = this.lastDelivered.get(filePath);
      const now = Date.now();
      if (
        previous &&
        (previous.signature === signature || now - previous.at < DELIVERY_COOLDOWN_MS)
      ) {
        return;
      }

      await this.bot.api.sendDocument(config.telegram.allowedUserId, new InputFile(filePath), {
        caption: captionFor(filePath, stat.size),
        disable_notification: true,
      });

      this.lastDelivered.set(filePath, { signature, at: now });
      logger.info(`[Artifact] Delivered generated file to Telegram: ${filePath} (${stat.size} bytes)`);
    } catch (error) {
      logger.error(`[Artifact] Failed to deliver generated file: ${filePath}`, error);
    }
  }
}

export const agentArtifactDeliveryService = new AgentArtifactDeliveryService();
