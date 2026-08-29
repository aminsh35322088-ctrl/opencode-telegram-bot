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
const ARTIFACT_MARKER = "__TELEGRAM_ARTIFACT__";

const IGNORED_PATH_SEGMENTS = new Set([
  ".git",
  "node_modules",
  ".opencode",
  ".cache",
  ".next",
]);

const SENSITIVE_PATH_SEGMENTS = new Set([
  ".ssh",
  ".aws",
  ".azure",
  ".gnupg",
]);

const GENERATED_NAME_HINTS = [
  "output",
  "result",
  "report",
  "export",
  "artifact",
  "generated",
  "download",
  "final",
  "render",
  "screenshot",
  "image",
  "document",
  "presentation",
  "spreadsheet",
  "archive",
  "bundle",
  "site",
  "build",
];

function normalizedSegments(filePath: string): string[] {
  return filePath
    .split(/[\\/]+/)
    .map((segment) => segment.toLowerCase())
    .filter(Boolean);
}

function isIgnoredPath(filePath: string): boolean {
  return normalizedSegments(filePath).some((segment) => IGNORED_PATH_SEGMENTS.has(segment));
}

function isSensitivePath(filePath: string): boolean {
  const segments = normalizedSegments(filePath);
  const basename = segments.at(-1) ?? "";

  if (segments.some((segment) => SENSITIVE_PATH_SEGMENTS.has(segment))) {
    return true;
  }

  return (
    basename === ".env" ||
    basename.startsWith(".env.") ||
    basename === "credentials" ||
    basename === "credentials.json" ||
    basename === "token" ||
    basename === "tokens.json" ||
    basename.endsWith(".pem") ||
    basename.endsWith(".key") ||
    basename === "id_rsa" ||
    basename === "id_ed25519"
  );
}

function isGeneratedName(filePath: string): boolean {
  const basename = path.basename(filePath).toLowerCase();
  return GENERATED_NAME_HINTS.some((hint) => basename.includes(hint));
}

function isLikelyText(sample: Buffer): boolean {
  if (sample.length === 0) {
    return true;
  }

  let controlBytes = 0;
  for (const byte of sample) {
    if (byte === 0) {
      return false;
    }
    if ((byte < 9 || (byte > 13 && byte < 32)) && byte !== 27) {
      controlBytes++;
    }
  }

  return controlBytes / sample.length < 0.02;
}

function isLikelyArtifactFromFileEvent(filePath: string, sample: Buffer): boolean {
  if (isIgnoredPath(filePath) || isSensitivePath(filePath)) {
    return false;
  }

  // Binary files are safe to treat as artifacts regardless of their extension.
  if (!isLikelyText(sample)) {
    return true;
  }

  // Text artifacts are only auto-delivered when their name strongly suggests a
  // generated user-facing result. Explicit agent delivery uses the marker path
  // below and does not rely on this heuristic.
  return isGeneratedName(filePath);
}

function extractArtifactMarkers(value: unknown): string[] {
  if (typeof value !== "string" || !value.includes(ARTIFACT_MARKER)) {
    return [];
  }

  const paths: string[] = [];
  const pattern = new RegExp(`${ARTIFACT_MARKER}\\s+([^\\n\\r]+)`, "g");
  for (const match of value.matchAll(pattern)) {
    const candidate = match[1]?.trim();
    if (candidate) {
      paths.push(candidate.replace(/^['\"]|['\"]$/g, ""));
    }
  }

  return [...new Set(paths)];
}

function isCompletedToolPart(event: Event): boolean {
  if (event.type !== "message.part.updated") {
    return false;
  }

  const part = event.properties.part;
  if (!part || part.type !== "tool") {
    return false;
  }

  return part.state.status === "completed";
}

function captionFor(filePath: string, size: number, caption?: string): string {
  if (caption?.trim()) {
    return caption.trim().slice(0, 1024);
  }

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
    if (event.type === "file.edited" || event.type === "file.watcher.updated") {
      const filePath = event.properties.file;
      if (typeof filePath !== "string") {
        return;
      }

      if (event.type === "file.watcher.updated" && event.properties.event === "unlink") {
        return;
      }

      void this.scheduleAutoDetection(filePath);
      return;
    }

    if (!isCompletedToolPart(event)) {
      return;
    }

    const part = event.properties.part;
    const state = part.state;
    const input = state.input as Record<string, unknown>;
    const markerPaths = [
      ...extractArtifactMarkers(state.output),
      ...extractArtifactMarkers(input.command),
    ];

    for (const filePath of markerPaths) {
      this.scheduleDelivery(filePath);
    }
  }

  clear(): void {
    for (const timer of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
    this.lastDelivered.clear();
  }

  private async scheduleAutoDetection(filePath: string): Promise<void> {
    try {
      if (isIgnoredPath(filePath) || isSensitivePath(filePath)) {
        return;
      }

      const sample = await fs.readFile(filePath).then((buffer) => buffer.subarray(0, 4096)).catch(() => null);
      if (!sample || !isLikelyArtifactFromFileEvent(filePath, sample)) {
        return;
      }

      this.scheduleDelivery(filePath);
    } catch (error) {
      logger.debug(`[Artifact] Unable to inspect generated file: ${filePath}`, error);
    }
  }

  private scheduleDelivery(filePath: string): void {
    if (isSensitivePath(filePath)) {
      logger.warn(`[Artifact] Refusing to deliver sensitive path: ${filePath}`);
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

  private async deliver(filePath: string, caption?: string): Promise<void> {
    try {
      if (isSensitivePath(filePath)) {
        return;
      }

      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat?.isFile() || stat.size > MAX_FILE_SIZE_BYTES || stat.size === 0) {
        logger.warn(`[Artifact] Skipping unavailable/empty/oversized file: ${filePath}`);
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
        caption: captionFor(filePath, stat.size, caption),
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
export const artifactDeliveryMarker = ARTIFACT_MARKER;
