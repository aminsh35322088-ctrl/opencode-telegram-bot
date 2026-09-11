import { promises as fs } from "node:fs";
import path from "node:path";
import { Bot, InputFile } from "grammy";
import { config } from "../../config.js";
import { createTelegramBotOptions } from "../telegram-client-options.js";
import { logger } from "../../utils/logger.js";
import type { Event } from "@opencode-ai/sdk/v2";
import { getTopicRuntimeContext } from "../../app/services/topic-runtime-context.js";

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
const DEBOUNCE_MS = 1500;
const DELIVERY_COOLDOWN_MS = 5000;
const ARTIFACT_MARKER = "__TELEGRAM_ARTIFACT__";

const IGNORED_PATH_SEGMENTS = new Set([".git", "node_modules", ".opencode", ".cache", ".next"]);
const SENSITIVE_PATH_SEGMENTS = new Set([".ssh", ".aws", ".azure", ".gnupg"]);
const GENERATED_NAME_HINTS = [
  "output", "result", "report", "export", "artifact", "generated", "download", "final",
  "render", "screenshot", "image", "document", "presentation", "spreadsheet", "archive",
  "bundle", "site", "build",
];

type ToolEventPart = {
  type: "tool";
  state: {
    status: string;
    input: Record<string, unknown>;
    output?: string;
  };
};

function normalizedSegments(filePath: string): string[] {
  return filePath.split(/[\\/]+/).map((segment) => segment.toLowerCase()).filter(Boolean);
}

export function isSensitiveArtifactPath(filePath: string): boolean {
  const segments = normalizedSegments(filePath);
  const basename = segments.at(-1) ?? "";

  if (segments.some((segment) => SENSITIVE_PATH_SEGMENTS.has(segment))) return true;
  if (basename === ".env" || basename.startsWith(".env.")) return true;
  if (basename === "credentials" || basename === "credentials.json") return true;
  if (basename === "token" || basename === "tokens.json") return true;
  if (basename.endsWith(".pem") || basename.endsWith(".key")) return true;
  if (basename === "id_rsa" || basename === "id_ed25519") return true;
  return false;
}

function isIgnoredPath(filePath: string): boolean {
  return normalizedSegments(filePath).some((segment) => IGNORED_PATH_SEGMENTS.has(segment));
}

function isGeneratedName(filePath: string): boolean {
  const basename = path.basename(filePath).toLowerCase();
  return GENERATED_NAME_HINTS.some((hint) => basename.includes(hint));
}

function isLikelyText(sample: Buffer): boolean {
  if (sample.length === 0) return true;

  let controlBytes = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if ((byte < 9 || (byte > 13 && byte < 32)) && byte !== 27) controlBytes++;
  }

  return controlBytes / sample.length < 0.02;
}

export function isLikelyArtifactFromFileEvent(filePath: string, sample: Buffer): boolean {
  if (isIgnoredPath(filePath) || isSensitiveArtifactPath(filePath)) return false;
  if (!isLikelyText(sample)) return true;
  return isGeneratedName(filePath);
}

export function extractArtifactMarkers(value: unknown): string[] {
  if (typeof value !== "string" || !value.includes(ARTIFACT_MARKER)) return [];

  const paths: string[] = [];
  const pattern = new RegExp(`${ARTIFACT_MARKER}\\s+([^\\n\\r]+)`, "g");
  for (const match of value.matchAll(pattern)) {
    const candidate = match[1]?.trim();
    if (candidate) paths.push(candidate.replace(/^['\"]|['\"]$/g, ""));
  }

  return [...new Set(paths)];
}

function getToolEventPart(event: Event): ToolEventPart | null {
  if (event.type !== "message.part.updated") return null;

  const properties = event.properties as { part?: unknown };
  const part = properties.part;
  if (!part || typeof part !== "object") return null;

  const candidate = part as Partial<ToolEventPart>;
  if (candidate.type !== "tool" || !candidate.state || typeof candidate.state !== "object") return null;
  if (typeof candidate.state.status !== "string") return null;
  if (!candidate.state.input || typeof candidate.state.input !== "object") return null;

  return candidate as ToolEventPart;
}

function captionFor(filePath: string, size: number): string {
  const sizeMb = (size / (1024 * 1024)).toFixed(2);
  return `📎 ${path.basename(filePath)} · ${sizeMb} MB`;
}

type DeliveryScope = { chatId: number; threadId: number; sessionId?: string; generation: object; sessionGeneration?: object };

class AgentArtifactDeliveryService {
  private botInstance: Bot | null = null;
  private readonly pending = new Map<string, { timer: ReturnType<typeof setTimeout>; scope: DeliveryScope }>();
  private readonly lastDelivered = new Map<string, { signature: string; at: number; sessionId?: string }>();
  private chatId: number | null = null;
  private generation = {};
  private readonly sessionGenerations = new Map<string, object>();

  private get bot(): Bot {
    if (!this.botInstance) {
      this.botInstance = new Bot(config.telegram.token, createTelegramBotOptions(config.telegram));
    }
    return this.botInstance;
  }

  setChatId(chatId: number | null): void {
    this.chatId = chatId;
  }

  processEvent(event: Event): void {
    const fileEvent = event.type === "file.edited" || event.type === "file.watcher.updated";
    const part = getToolEventPart(event);
    const markerPaths = part?.state.status === "completed" ? [
      ...extractArtifactMarkers(part.state.output),
      ...extractArtifactMarkers(part.state.input.command),
    ] : [];
    // Heartbeats and ordinary text parts carry no artifact; missing a destination
    // for those events must not flood production logs with dropped-file warnings.
    if (!fileEvent && markerPaths.length === 0) return;
    // Capture identity before asynchronous inspection or delayed delivery.
    // Never resolve the destination from a later foreground chat selection.
    const runtime = getTopicRuntimeContext();
    const scope: DeliveryScope | null = runtime
      ? { chatId: runtime.chatId, threadId: runtime.threadId, sessionId: runtime.sessionId, generation: this.generation, sessionGeneration: runtime.sessionId ? this.sessionGenerations.get(runtime.sessionId) : undefined }
      : this.chatId === null ? null : { chatId: this.chatId, threadId: 0, generation: this.generation };
    if (!scope) {
      logger.warn(`[Artifact] No Telegram destination at event time; refusing delivery for generated file`);
      return;
    }

    if (event.type === "file.edited" || event.type === "file.watcher.updated") {
      const properties = event.properties as { file?: unknown; event?: unknown };
      const filePath = properties.file;
      if (typeof filePath !== "string") return;
      if (event.type === "file.watcher.updated" && properties.event === "unlink") return;
      void this.scheduleAutoDetection(filePath, scope);
      return;
    }

    for (const filePath of markerPaths) this.scheduleDelivery(filePath, scope);
  }

  retireSession(sessionId: string): void {
    this.sessionGenerations.set(sessionId, {});
    for (const [key, entry] of this.pending) {
      if (entry.scope.sessionId !== sessionId) continue;
      clearTimeout(entry.timer);
      this.pending.delete(key);
    }
    for (const [key, entry] of this.lastDelivered) {
      if (entry.sessionId === sessionId) this.lastDelivered.delete(key);
    }
  }

  private isCurrent(scope: DeliveryScope): boolean {
    return scope.generation === this.generation && (!scope.sessionId ||
      scope.sessionGeneration === this.sessionGenerations.get(scope.sessionId));
  }

  clear(): void {
    this.generation = {};
    this.sessionGenerations.clear();
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    this.lastDelivered.clear();
    this.chatId = null;
  }

  private async scheduleAutoDetection(filePath: string, scope: DeliveryScope): Promise<void> {
    try {
      if (isIgnoredPath(filePath) || isSensitiveArtifactPath(filePath)) return;
      const sample = await fs.readFile(filePath).then((buffer) => buffer.subarray(0, 4096)).catch(() => null);
      if (!this.isCurrent(scope) || !sample || !isLikelyArtifactFromFileEvent(filePath, sample)) return;
      this.scheduleDelivery(filePath, scope);
    } catch (error) {
      logger.debug(`[Artifact] Unable to inspect generated file: ${filePath}`, error);
    }
  }

  private scheduleDelivery(filePath: string, scope: DeliveryScope): void {
    if (!this.isCurrent(scope)) return;
    if (isSensitiveArtifactPath(filePath)) {
      logger.warn(`[Artifact] Refusing to deliver sensitive path: ${filePath}`);
      return;
    }

    const key = JSON.stringify([scope.chatId, scope.threadId, scope.sessionId ?? null, filePath]);
    const previous = this.pending.get(key);
    if (previous) clearTimeout(previous.timer);

    const timer = setTimeout(() => {
      this.pending.delete(key);
      void this.deliver(filePath, scope, key);
    }, DEBOUNCE_MS);
    this.pending.set(key, { timer, scope });
  }

  private async deliver(filePath: string, scope: DeliveryScope, key: string): Promise<void> {
    try {
      if (isSensitiveArtifactPath(filePath)) return;
      if (!this.isCurrent(scope)) return;
      const targetChatId = scope.chatId;
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat?.isFile() || stat.size > MAX_FILE_SIZE_BYTES || stat.size === 0) {
        logger.warn(`[Artifact] Skipping unavailable/empty/oversized file: ${filePath}`);
        return;
      }

      if (!this.isCurrent(scope)) return;
      const signature = `${stat.size}:${stat.mtimeMs}`;
      const previous = this.lastDelivered.get(key);
      const now = Date.now();
      if (previous && (previous.signature === signature || now - previous.at < DELIVERY_COOLDOWN_MS)) return;

      await this.bot.api.sendDocument(targetChatId, new InputFile(filePath), {
        caption: captionFor(filePath, stat.size),
        disable_notification: true,
        ...(scope && scope.threadId > 1 ? { message_thread_id: scope.threadId } : {}),
      });

      if (this.isCurrent(scope)) this.lastDelivered.set(key, { signature, at: now, sessionId: scope.sessionId });
      logger.info(`[Artifact] Delivered generated file to Telegram chat ${targetChatId}: ${filePath} (${stat.size} bytes)`);
    } catch (error) {
      logger.error(`[Artifact] Failed to deliver generated file: ${filePath}`, error);
    }
  }
}

export const agentArtifactDeliveryService = new AgentArtifactDeliveryService();
export const artifactDeliveryMarker = ARTIFACT_MARKER;
