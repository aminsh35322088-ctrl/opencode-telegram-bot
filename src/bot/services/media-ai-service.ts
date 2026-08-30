import { downloadTelegramFile } from "../../app/services/file-download-service.js";
import type { Context } from "grammy";
import { editImageWithFallback, generateImageWithFallback, hasActiveImageAiProvider } from "../../app/services/image-ai-provider-service.js";

export interface GeneratedMediaImage { buffer: Buffer; mimeType: string; }

export async function isMediaAiConfigured(): Promise<boolean> { return hasActiveImageAiProvider("generate") || hasActiveImageAiProvider("edit"); }
export async function generateImage(prompt: string): Promise<GeneratedMediaImage> { if (!prompt.trim()) throw new Error("Image prompt is empty."); return generateImageWithFallback(prompt.trim()); }
export async function editImage(image: Buffer, mimeType: string, prompt: string): Promise<GeneratedMediaImage> { if (!prompt.trim()) throw new Error("Image edit prompt is empty."); return editImageWithFallback(image, mimeType, prompt.trim()); }
export async function downloadPhoto(ctx: Context): Promise<{ buffer: Buffer; mimeType: string }> { const photos = ctx.message?.photo; if (!photos?.length) throw new Error("No photo was attached."); const photo = photos[photos.length - 1]!; const downloaded = await downloadTelegramFile(ctx.api, photo.file_id); return { buffer: downloaded.buffer, mimeType: "image/jpeg" }; }
export async function downloadRepliedPhoto(ctx: Context): Promise<{ buffer: Buffer; mimeType: string }> { const photos = ctx.message?.reply_to_message?.photo; if (!photos?.length) throw new Error("Reply to a photo to use /edit."); const photo = photos[photos.length - 1]!; const downloaded = await downloadTelegramFile(ctx.api, photo.file_id); return { buffer: downloaded.buffer, mimeType: "image/jpeg" }; }
