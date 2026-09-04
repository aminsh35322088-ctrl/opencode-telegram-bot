import path from "node:path";
import type { Context } from "grammy";
import { downloadTelegramFile } from "./file-download-service.js";
import { promptAttachment } from "../managers/prompt-attachment-manager.js";
import { logger } from "../../utils/logger.js";

const REPLY_ASSET_DIR = ".telegram/replies";

function extensionForMime(mimeType: string | undefined, fallback = "bin"): string {
  if (!mimeType) return fallback;
  const subtype = mimeType.split("/")[1]?.split(";")[0]?.trim();
  return subtype && /^[a-z0-9.+-]+$/iu.test(subtype) ? subtype : fallback;
}

function textFromMessage(message: Record<string, unknown>): string {
  const text = typeof message.text === "string" ? message.text.trim() : "";
  const caption = typeof message.caption === "string" ? message.caption.trim() : "";
  if (text && caption) return `${text}\n${caption}`;
  return text || caption;
}

function describeReply(message: Record<string, unknown>): string {
  const from = message.from && typeof message.from === "object"
    ? ((message.from as Record<string, unknown>).first_name as string | undefined)
    : undefined;
  const content = textFromMessage(message);
  const label = from ? `@${from}` : "the previous message";
  return content ? `Replying to ${label}:\n---\n${content}\n---` : `Replying to ${label}.`;
}

async function saveReplyPhoto(ctx: Context, message: Record<string, unknown>, workspace: string): Promise<string | null> {
  const photos = Array.isArray(message.photo) ? message.photo : [];
  const photo = photos[photos.length - 1];
  const fileId = photo && typeof photo === "object" ? (photo as Record<string, unknown>).file_id : undefined;
  if (typeof fileId !== "string" || !fileId) return null;

  const downloaded = await downloadTelegramFile(ctx.api, fileId);
  const relativePath = path.join(REPLY_ASSET_DIR, `reply-${String(message.message_id ?? Date.now())}.jpg`);
  const absolutePath = path.resolve(workspace, relativePath);
  const fs = await import("fs/promises");
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, downloaded.buffer);
  promptAttachment.set(absolutePath, workspace);
  return relativePath;
}

async function saveReplyDocument(ctx: Context, message: Record<string, unknown>, workspace: string): Promise<string | null> {
  const document = message.document;
  if (!document || typeof document !== "object") return null;
  const value = document as Record<string, unknown>;
  const fileId = value.file_id;
  if (typeof fileId !== "string" || !fileId) return null;

  const downloaded = await downloadTelegramFile(ctx.api, fileId);
  const rawName = typeof value.file_name === "string" ? value.file_name : `reply-${String(message.message_id ?? Date.now())}`;
  const safeName = path.basename(rawName).replace(/[^a-zA-Z0-9._-]/gu, "_") || "reply.bin";
  const extension = path.extname(safeName) || `.${extensionForMime(typeof value.mime_type === "string" ? value.mime_type : undefined)}`;
  const base = path.basename(safeName, path.extname(safeName));
  const filename = `${base}-reply-${String(message.message_id ?? Date.now())}${extension}`;
  const relativePath = path.join(REPLY_ASSET_DIR, filename);
  const absolutePath = path.resolve(workspace, relativePath);
  const fs = await import("fs/promises");
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, downloaded.buffer);
  promptAttachment.set(absolutePath, workspace);
  return relativePath;
}

export async function enrichTelegramReplyContext(ctx: Context, workspace: string): Promise<void> {
  const message = ctx.message as (Record<string, unknown> & { reply_to_message?: unknown }) | undefined;
  const replied = message?.reply_to_message;
  if (!message || !replied || typeof replied !== "object") return;

  const replyMessage = replied as Record<string, unknown>;
  const description = describeReply(replyMessage);
  const replyPhotoPath = await saveReplyPhoto(ctx, replyMessage, workspace).catch((error) => {
    logger.warn("[TelegramTopics] Failed to persist replied photo:", error);
    return null;
  });
  const replyDocumentPath = replyPhotoPath
    ? null
    : await saveReplyDocument(ctx, replyMessage, workspace).catch((error) => {
      logger.warn("[TelegramTopics] Failed to persist replied document:", error);
      return null;
    });

  const assetNote = replyPhotoPath || replyDocumentPath
    ? `\nReferenced asset saved at: ${replyPhotoPath || replyDocumentPath}`
    : "";
  const currentText = typeof message.text === "string" ? message.text.trim() : "";
  if (currentText) {
    message.text = `${description}${assetNote}\n\n${currentText}`;
  } else if (typeof message.caption === "string" && message.caption.trim()) {
    message.caption = `${description}${assetNote}\n\n${message.caption.trim()}`;
  }

  logger.debug(
    `[TelegramTopics] Enriched reply context: chat=${ctx.chat?.id ?? "unknown"}, replyMessage=${String(replyMessage.message_id ?? "unknown")}, asset=${replyPhotoPath || replyDocumentPath || "none"}`,
  );
}
