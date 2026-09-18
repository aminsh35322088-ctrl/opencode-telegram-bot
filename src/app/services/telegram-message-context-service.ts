import fs from "node:fs/promises";
import path from "node:path";
import type { Context } from "grammy";
import { config } from "../../config.js";
import { readAppState, updateAppState } from "../stores/app-state-store.js";

const STATE_KEY = "telegramMessageContexts";
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

export type TelegramMediaKind = "photo" | "document" | "video" | "video_note" | "voice" | "audio";
export interface TelegramMediaSnapshot {
  kind: TelegramMediaKind;
  fileId: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
}
export interface TelegramMessageSnapshot {
  messageId: number;
  date?: number;
  text?: string;
  caption?: string;
  media: TelegramMediaSnapshot[];
  forward?: Record<string, unknown>;
  reply?: Omit<TelegramMessageSnapshot, "reply">;
}
export interface TelegramTopicMessageContext {
  chatId: number;
  threadId: number;
  sessionId?: string;
  worktree: string;
  updatedAt: string;
  message: TelegramMessageSnapshot;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function string(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function mediaEntry(kind: TelegramMediaKind, value: unknown): TelegramMediaSnapshot | undefined {
  const item = record(value); const fileId = string(item?.file_id); if (!fileId) return undefined;
  return { kind, fileId, ...(string(item?.file_name) ? { fileName: string(item?.file_name) } : {}), ...(string(item?.mime_type) ? { mimeType: string(item?.mime_type) } : {}), ...(number(item?.file_size) !== undefined ? { fileSize: number(item?.file_size) } : {}) };
}
function mediaFrom(message: Record<string, unknown>): TelegramMediaSnapshot[] {
  const media: TelegramMediaSnapshot[] = [];
  const photos = Array.isArray(message.photo) ? message.photo : [];
  const photo = photos.length ? mediaEntry("photo", photos[photos.length - 1]) : undefined;
  if (photo) media.push(photo);
  for (const kind of ["document", "video", "video_note", "voice", "audio"] as const) {
    const item = mediaEntry(kind, message[kind]); if (item) media.push(item);
  }
  return media;
}
function safeForward(origin: unknown): Record<string, unknown> | undefined {
  const value = record(origin); if (!value) return undefined;
  const result: Record<string, unknown> = {};
  for (const key of ["type", "date", "message_id"] as const) if (["string", "number"].includes(typeof value[key])) result[key] = value[key];
  const sender = record(value.sender_user); if (sender) result.sender = { id: number(sender.id), firstName: string(sender.first_name), username: string(sender.username) };
  const chat = record(value.chat); if (chat) result.chat = { id: number(chat.id), title: string(chat.title), username: string(chat.username), type: string(chat.type) };
  const senderName = string(value.sender_user_name); if (senderName) result.senderName = senderName;
  return Object.keys(result).length ? result : undefined;
}
function snapshotMessage(value: unknown, includeReply: boolean): TelegramMessageSnapshot | undefined {
  const message = record(value); const messageId = number(message?.message_id); if (!message || messageId === undefined) return undefined;
  const reply = includeReply ? snapshotMessage(message.reply_to_message, false) : undefined;
  const forward = safeForward(message.forward_origin);
  return {
    messageId,
    ...(number(message.date) !== undefined ? { date: number(message.date) } : {}),
    ...(string(message.text) ? { text: string(message.text) } : {}),
    ...(string(message.caption) ? { caption: string(message.caption) } : {}),
    media: mediaFrom(message),
    ...(forward ? { forward } : {}),
    ...(reply ? { reply } : {}),
  };
}

export function buildTelegramMessageSnapshot(ctx: Context): TelegramMessageSnapshot | undefined { return snapshotMessage(ctx.message, true); }

export async function captureTelegramMessageContext(ctx: Context, input: { chatId: number; threadId: number; sessionId?: string; worktree: string }): Promise<void> {
  const message = buildTelegramMessageSnapshot(ctx); if (!message) return;
  const worktree = path.resolve(input.worktree);
  const snapshot: TelegramTopicMessageContext = { chatId: input.chatId, threadId: input.threadId, ...(input.sessionId ? { sessionId: input.sessionId } : {}), worktree, updatedAt: new Date().toISOString(), message };
  await updateAppState((state) => {
    const existing = record(state[STATE_KEY]) ?? {};
    const next = { ...existing, [`worktree:${worktree}`]: snapshot };
    if (input.sessionId) next[`session:${input.sessionId}`] = snapshot;
    return { [STATE_KEY]: next };
  });
}

export async function getTelegramMessageContext(worktree: string, sessionId?: string): Promise<TelegramTopicMessageContext | null> {
  const contexts = record((await readAppState())[STATE_KEY]);
  const resolved = path.resolve(worktree);
  const value = (sessionId ? contexts?.[`session:${sessionId}`] : undefined) ?? contexts?.[`worktree:${resolved}`] ?? contexts?.[resolved];
  return record(value) ? value as unknown as TelegramTopicMessageContext : null;
}

function safeTarget(worktree: string, raw: string): string {
  const target = path.resolve(worktree, raw); const relative = path.relative(worktree, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Telegram media output must stay inside the current worktree.");
  return target;
}

export async function fetchTelegramContextMedia(worktree: string, input: { target?: "current" | "reply"; index?: number; output?: string }, sessionId?: string): Promise<{ path: string; media: TelegramMediaSnapshot }> {
  const context = await getTelegramMessageContext(worktree, sessionId); if (!context) throw new Error("No Telegram message context is available for this worktree.");
  const message = input.target === "reply" ? context.message.reply : context.message;
  if (!message) throw new Error("The current Telegram message has no replied message context.");
  const index = Math.trunc(input.index ?? 0); const media = message.media[index];
  if (!media) throw new Error(`No Telegram media at index ${index} for target=${input.target ?? "current"}.`);
  if ((media.fileSize ?? 0) > MAX_MEDIA_BYTES) throw new Error("Telegram media exceeds the 20 MB agent fetch limit.");
  const token = config.telegram.token; if (!token) throw new Error("Telegram bot token is not configured.");
  const fileInfo = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(media.fileId)}`);
  const payload = await fileInfo.json() as { ok?: boolean; result?: { file_path?: string }; description?: string };
  const filePath = payload.result?.file_path; if (!fileInfo.ok || !payload.ok || !filePath) throw new Error(payload.description || "Telegram getFile failed.");
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  if (!response.ok) throw new Error(`Telegram media download failed (HTTP ${response.status}).`);
  const contentLength = Number(response.headers.get("content-length") || 0); if (contentLength > MAX_MEDIA_BYTES) throw new Error("Telegram media exceeds the 20 MB agent fetch limit.");
  const buffer = Buffer.from(await response.arrayBuffer()); if (buffer.length > MAX_MEDIA_BYTES) throw new Error("Telegram media exceeds the 20 MB agent fetch limit.");
  const fallbackName = path.basename(filePath) || `${media.kind}-${Date.now()}`;
  const output = safeTarget(worktree, input.output?.trim() || path.join(".telegram", "fetched", fallbackName));
  await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, buffer);
  return { path: output, media };
}