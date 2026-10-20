import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { nodeBindings } from "../../control-plane/node-bindings.js";
import { findTelegramTopicBindingByThread } from "./telegram-topic-store.js";
import { getTelegramMessageContext, type TelegramMediaSnapshot, type TelegramMessageSnapshot, type TelegramTopicMessageContext } from "./telegram-message-context-service.js";
import { downloadTelegramFileById } from "./file-download-service.js";

const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const CHUNK_BYTES = 512 * 1024;
const MAX_ACTIVE_TRANSFERS = 16;
const TRANSFER_TTL_MS = 120_000;

export interface TelegramAgentOwner {
  nodeId: string;
  generation: number;
  chatId: number;
  threadId: number;
  sessionId: string;
}
interface Transfer {
  id: string;
  owner: TelegramAgentOwner;
  directory: string;
  filePath: string;
  filename: string;
  mimeType: string;
  size: number;
  expiresAt: number;
}
const transfers = new Map<string, Transfer>();

function sameOwner(left: TelegramAgentOwner, right: TelegramAgentOwner): boolean {
  return left.nodeId === right.nodeId && left.generation === right.generation && left.chatId === right.chatId &&
    left.threadId === right.threadId && left.sessionId === right.sessionId;
}
function validOwner(value: unknown): value is TelegramAgentOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as TelegramAgentOwner;
  return typeof owner.nodeId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(owner.nodeId) &&
    Number.isSafeInteger(owner.generation) && owner.generation > 0 && Number.isSafeInteger(owner.chatId) && owner.chatId !== 0 &&
    Number.isSafeInteger(owner.threadId) && owner.threadId > 1 && typeof owner.sessionId === "string" && owner.sessionId.length > 0 && owner.sessionId.length <= 256;
}
async function assertOwner(owner: TelegramAgentOwner): Promise<void> {
  const current = await nodeBindings.find(owner.chatId, owner.threadId);
  if (!current || current.status !== "ready" || current.nodeId !== owner.nodeId || current.generation !== owner.generation || current.sessionId !== owner.sessionId) {
    throw new Error("Telegram capability Topic Worker binding changed.");
  }
  const topic = await findTelegramTopicBindingByThread(owner.chatId, owner.threadId);
  if (!topic || topic.sessionId !== owner.sessionId) throw new Error("Telegram capability Topic session changed.");
}
function safeMessage(message: TelegramMessageSnapshot | undefined): unknown {
  if (!message) return null;
  return {
    messageId: message.messageId,
    ...(message.date !== undefined ? { date: message.date } : {}),
    ...(message.text ? { text: message.text } : {}),
    ...(message.caption ? { caption: message.caption } : {}),
    media: message.media.map((media) => ({ kind: media.kind, ...(media.fileName ? { fileName: media.fileName } : {}), ...(media.mimeType ? { mimeType: media.mimeType } : {}), ...(media.fileSize !== undefined ? { fileSize: media.fileSize } : {}) })),
    ...(message.forward ? { forward: message.forward } : {}),
    ...(message.reply ? { reply: safeMessage(message.reply) } : {}),
  };
}
function safeFilename(media: TelegramMediaSnapshot, filePath: string, messageId: number): string {
  const candidate = media.fileName || path.basename(filePath) || `${media.kind}-${messageId}`;
  return path.basename(candidate).replace(/[^a-zA-Z0-9._-]/gu, "_").slice(0, 180) || `${media.kind}-${messageId}`;
}
async function removeTransfer(transfer: Transfer): Promise<void> {
  transfers.delete(transfer.id);
  await fs.rm(transfer.directory, { recursive: true, force: true }).catch(() => undefined);
}
async function cleanExpired(): Promise<void> {
  const now = Date.now();
  for (const transfer of transfers.values()) if (transfer.expiresAt <= now) await removeTransfer(transfer);
}

async function createTransfer(owner: TelegramAgentOwner, filenameValue: string, mimeType: string, buffer: Buffer): Promise<Record<string, unknown>> {
  if (transfers.size >= MAX_ACTIVE_TRANSFERS) throw new Error("Telegram media transfer capacity exceeded.");
  if (!buffer.length || buffer.length > MAX_MEDIA_BYTES) throw new Error("Generated media exceeds the 20 MB transfer limit.");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-agent-transfer-"));
  const filename = path.basename(filenameValue).replace(/[^a-zA-Z0-9._-]/gu, "_").slice(0, 180) || "media.bin";
  const filePath = path.join(directory, filename);
  try {
    await fs.writeFile(filePath, buffer, { mode: 0o600, flag: "wx" });
    const transfer: Transfer = { id: randomUUID(), owner: { ...owner }, directory, filePath, filename, mimeType, size: buffer.length, expiresAt: Date.now() + TRANSFER_TTL_MS };
    transfers.set(transfer.id, transfer);
    return { transferId: transfer.id, filename, mimeType, size: buffer.length };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
async function selectedMedia(context: TelegramTopicMessageContext, input: Record<string, unknown>): Promise<{ media: TelegramMediaSnapshot; buffer: Buffer; filename: string; mimeType: string }> {
  if (Object.keys(input).some((key) => !["action", "target", "index", "prompt"].includes(key)) ||
    !["current", "reply"].includes(String(input.target ?? "current")) || !Number.isSafeInteger(input.index ?? 0) || Number(input.index ?? 0) < 0 || Number(input.index ?? 0) > 5) {
    throw new Error("Invalid Telegram media selection.");
  }
  const message = input.target === "reply" ? context.message.reply : context.message;
  if (!message) throw new Error("The current Telegram message has no replied message context.");
  const media = message.media[Number(input.index ?? 0)];
  if (!media) throw new Error("Telegram media index is unavailable.");
  if ((media.fileSize ?? 0) > MAX_MEDIA_BYTES) throw new Error("Telegram media exceeds the 20 MB transfer limit.");
  const downloaded = await downloadTelegramFileById(media.fileId, { maxBytes: MAX_MEDIA_BYTES });
  if (!downloaded.buffer.length || downloaded.buffer.length > MAX_MEDIA_BYTES) throw new Error("Telegram media size is invalid.");
  return { media, buffer: downloaded.buffer, filename: safeFilename(media, downloaded.filePath, message.messageId), mimeType: media.mimeType || "application/octet-stream" };
}

export async function runTelegramAgentAccess(payload: unknown, ownerValue: unknown): Promise<unknown> {
  if (!validOwner(ownerValue)) throw new Error("Telegram capability owner invalid.");
  const owner = ownerValue;
  await assertOwner(owner);
  await cleanExpired();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Telegram capability payload invalid.");
  const input = payload as Record<string, unknown>;
  const action = input.action;
  if (action === "ssh.public-key") {
    if (Object.keys(input).length !== 1) throw new Error("Invalid SSH public-key request.");
    const { getManagedSshPublicKey } = await import("./ssh-key-service.js");
    return { ok: true, publicKey: await getManagedSshPublicKey(), purpose: "Public key only; never exposes private key material." };
  }
  const context = await getTelegramMessageContext(process.cwd(), owner.sessionId);
  if (!context || context.chatId !== owner.chatId || context.threadId !== owner.threadId || context.sessionId !== owner.sessionId) {
    throw new Error("No Telegram message context is available for this Topic.");
  }
  if (action === "context.current") {
    if (Object.keys(input).length !== 1) throw new Error("Invalid Telegram context request.");
    return { updatedAt: context.updatedAt, message: safeMessage(context.message) };
  }
  if (action === "reply.resolve") {
    if (Object.keys(input).length !== 1) throw new Error("Invalid Telegram reply request.");
    return { message: safeMessage(context.message.reply) };
  }
  if (action === "forward.inspect") {
    if (Object.keys(input).length !== 1) throw new Error("Invalid Telegram forward request.");
    return { messageId: context.message.messageId, forward: context.message.forward ?? null };
  }
  if (["image.providers", "image.models", "image.current", "image.generate", "image.edit", "stt.status", "stt.transcribe", "video.prepare"].includes(String(action))) {
    const { worktree } = context;
    if (action === "image.providers" || action === "image.models") {
      if (Object.keys(input).some((key) => key !== "action")) throw new Error("Invalid Image AI catalog request.");
      const { listImageModelCatalog } = await import("./image-model-catalog-service.js");
      const models = await listImageModelCatalog();
      if (action === "image.providers") return { providers: [...new Map(models.map((model) => [model.providerID, { id: model.providerID, name: model.providerName }])).values()] };
      return { models };
    }
    if (action === "image.current") {
      if (Object.keys(input).some((key) => key !== "action")) throw new Error("Invalid Image AI selection request.");
      const { resolvePersistedImageModel } = await import("./image-model-resolution-service.js");
      return { selection: await resolvePersistedImageModel(worktree) ?? null };
    }
    if (action === "stt.status") {
      if (Object.keys(input).some((key) => key !== "action")) throw new Error("Invalid speech-to-text status request.");
      const { isSttConfigured } = await import("./stt-service.js");
      return { configured: await isSttConfigured() };
    }
    if (action === "stt.transcribe") {
      if (typeof input.target !== "undefined" && !["current", "reply"].includes(String(input.target))) throw new Error("Invalid speech-to-text target.");
      const selected = await selectedMedia(context, input);
      if (!(selected.media.kind === "voice" || selected.media.kind === "audio" || selected.media.kind === "video" || selected.media.kind === "video_note")) throw new Error("Selected Telegram media is not audio or video.");
      const { transcribeAudio } = await import("./stt-service.js");
      return await transcribeAudio(selected.buffer, selected.filename);
    }
    if (action === "video.prepare") {
      const selected = await selectedMedia(context, input);
      if (!(selected.media.kind === "video" || selected.media.kind === "video_note" || selected.mimeType.startsWith("video/"))) throw new Error("Selected Telegram media is not a video.");
      const { extractVideoFrames, extractVideoAudio } = await import("./video-preparation-service.js");
      const frames = await extractVideoFrames(selected.buffer, selected.filename);
      const audio = await extractVideoAudio(selected.buffer, selected.filename);
      const frameTransfers = [];
      for (const frame of frames) frameTransfers.push(await createTransfer(owner, frame.filename, "image/jpeg", frame.buffer));
      const audioTransfer = audio ? await createTransfer(owner, audio.filename, "audio/ogg", audio.buffer) : null;
      return { ok: true, source: selected.filename, frames: frameTransfers, audio: audioTransfer };
    }
    const allowedKeys = action === "image.generate" ? ["action", "prompt"] : ["action", "prompt", "target", "index"];
    if (Object.keys(input).some((key) => !allowedKeys.includes(key))) throw new Error("Invalid Image AI request fields.");
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!prompt || prompt.length > 6000) throw new Error("Image generation/edit requires a prompt of 1–6000 characters.");
    const { generateConfiguredImage, editConfiguredImage } = await import("./image-action-service.js");
    const signal = AbortSignal.timeout(180_000);
    const result = action === "image.generate"
      ? await generateConfiguredImage(prompt, signal, worktree, { sessionId: owner.sessionId, directory: worktree })
      : await (async () => {
          const selected = await selectedMedia(context, input);
          if (!(selected.media.kind === "photo" || selected.media.mimeType?.startsWith("image/"))) throw new Error("Selected Telegram media is not an image.");
          const { detectImageMimeType } = await import("./ai-http-service.js");
          const mimeType = detectImageMimeType(selected.buffer);
          if (!mimeType) throw new Error("Selected Telegram media is not a supported image.");
          return editConfiguredImage(prompt, { buffer: selected.buffer, mimeType }, signal, worktree, { sessionId: owner.sessionId, directory: worktree });
        })();
    const extension = result.mimeType === "image/jpeg" ? ".jpg" : result.mimeType === "image/webp" ? ".webp" : result.mimeType === "image/gif" ? ".gif" : ".png";
    return { ok: true, ...(await createTransfer(owner, `image-${Date.now()}${extension}`, result.mimeType, result.buffer)), selection: await (await import("./image-model-resolution-service.js")).resolvePersistedImageModel(worktree) ?? null };
  }
  if (action === "media.begin") {
    if (Object.keys(input).some((key) => !["action", "target", "index"].includes(key)) ||
      !["current", "reply"].includes(String(input.target)) || !Number.isSafeInteger(input.index) || Number(input.index) < 0 || Number(input.index) > 5) {
      throw new Error("Invalid Telegram media selection.");
    }
    if (transfers.size >= MAX_ACTIVE_TRANSFERS) throw new Error("Telegram media transfer capacity exceeded.");
    const selected = await selectedMedia(context, input);
    return await createTransfer(owner, selected.filename, selected.mimeType, selected.buffer);
  }
  if (action === "media.chunk") {
    if (Object.keys(input).some((key) => !["action", "transferId", "offset", "limit"].includes(key)) ||
      typeof input.transferId !== "string" || !Number.isSafeInteger(input.offset) || Number(input.offset) < 0 ||
      !Number.isSafeInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > CHUNK_BYTES) throw new Error("Invalid Telegram media chunk request.");
    const transfer = transfers.get(input.transferId);
    if (!transfer || transfer.expiresAt <= Date.now() || !sameOwner(transfer.owner, owner)) throw new Error("Telegram media transfer expired or belongs to another Topic.");
    if (Number(input.offset) > transfer.size) throw new Error("Telegram media offset is invalid.");
    const length = Math.min(Number(input.limit), transfer.size - Number(input.offset));
    const handle = await fs.open(transfer.filePath, "r");
    try {
      const buffer = Buffer.alloc(length);
      const result = length ? await handle.read(buffer, 0, length, Number(input.offset)) : { bytesRead: 0 };
      if (result.bytesRead !== length) throw new Error("Telegram media chunk read was incomplete.");
      const nextOffset = Number(input.offset) + length;
      transfer.expiresAt = Date.now() + TRANSFER_TTL_MS;
      return { offset: Number(input.offset), nextOffset, size: transfer.size, eof: nextOffset >= transfer.size, data: buffer.toString("base64") };
    } finally { await handle.close(); }
  }
  if (action === "media.finish") {
    if (Object.keys(input).some((key) => !["action", "transferId"].includes(key)) || typeof input.transferId !== "string") throw new Error("Invalid Telegram media cleanup request.");
    const transfer = transfers.get(input.transferId);
    if (transfer && sameOwner(transfer.owner, owner)) await removeTransfer(transfer);
    return { cleaned: true };
  }
  throw new Error("Unsupported Telegram capability action.");
}

export async function resetTelegramAgentAccessForTests(): Promise<void> {
  for (const transfer of transfers.values()) await removeTransfer(transfer);
  transfers.clear();
}
