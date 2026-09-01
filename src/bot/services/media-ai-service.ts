import { downloadTelegramFile } from "../../app/services/file-download-service.js";
import type { Context } from "grammy";

export interface GeneratedMediaImage { buffer: Buffer; mimeType: string; }

export async function downloadPhoto(ctx: Context): Promise<{ buffer: Buffer; mimeType: string }> { const photos = ctx.message?.photo; if (!photos?.length) throw new Error("No photo was attached."); const photo = photos[photos.length - 1]!; const downloaded = await downloadTelegramFile(ctx.api, photo.file_id); return { buffer: downloaded.buffer, mimeType: "image/jpeg" }; }
export async function downloadRepliedPhoto(ctx: Context): Promise<{ buffer: Buffer; mimeType: string }> { const photos = ctx.message?.reply_to_message?.photo; if (!photos?.length) throw new Error("Reply to a photo to use /edit."); const photo = photos[photos.length - 1]!; const downloaded = await downloadTelegramFile(ctx.api, photo.file_id); return { buffer: downloaded.buffer, mimeType: "image/jpeg" }; }
