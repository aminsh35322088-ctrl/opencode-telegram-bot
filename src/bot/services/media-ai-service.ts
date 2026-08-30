import { downloadTelegramFile } from "../../app/services/file-download-service.js";
import { config } from "../../config.js";
import type { Context } from "grammy";

interface GeminiImageBlock {
  data: string;
  mime_type?: string;
  mimeType?: string;
}

export interface GeneratedMediaImage {
  buffer: Buffer;
  mimeType: string;
}

function getGeminiConfig(): { apiKey: string; model: string } {
  return {
    apiKey: config.media.geminiApiKey,
    model: config.media.geminiImageModel,
  };
}

function findImageBlock(value: unknown): GeminiImageBlock | null {
  if (!value || typeof value !== "object") return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findImageBlock(item);
      if (found) return found;
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of ["output_image", "inlineData", "inline_data", "image"]) {
    const candidate = record[key];
    if (candidate && typeof candidate === "object") {
      const image = candidate as Record<string, unknown>;
      if (typeof image.data === "string") {
        return {
          data: image.data,
          mime_type: typeof image.mime_type === "string" ? image.mime_type : undefined,
          mimeType: typeof image.mimeType === "string" ? image.mimeType : undefined,
        };
      }
    }
  }

  for (const candidate of Object.values(record)) {
    const found = findImageBlock(candidate);
    if (found) return found;
  }

  return null;
}

async function requestImage(input: unknown): Promise<GeneratedMediaImage> {
  const { apiKey, model } = getGeminiConfig();
  if (!apiKey) {
    throw new Error("Gemini image generation is not configured. Set GEMINI_API_KEY first.");
  }

  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      model,
      input,
      response_format: { type: "image" },
    }),
  });

  const payload = (await response.json()) as unknown;
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? JSON.stringify((payload as Record<string, unknown>).error)
        : `Gemini request failed with HTTP ${response.status}`;
    throw new Error(message);
  }

  const image = findImageBlock(payload);
  if (!image) {
    throw new Error("Gemini returned no image data.");
  }

  return {
    buffer: Buffer.from(image.data, "base64"),
    mimeType: image.mime_type ?? image.mimeType ?? "image/png",
  };
}

export function isMediaAiConfigured(): boolean {
  return Boolean(config.media.geminiApiKey);
}

export async function generateImage(prompt: string): Promise<GeneratedMediaImage> {
  return requestImage(prompt);
}

export async function editImage(
  image: Buffer,
  mimeType: string,
  prompt: string,
): Promise<GeneratedMediaImage> {
  return requestImage([
    { type: "text", text: prompt },
    { type: "image", data: image.toString("base64"), mime_type: mimeType },
  ]);
}

export async function downloadPhoto(ctx: Context): Promise<{ buffer: Buffer; mimeType: string }> {
  const photos = ctx.message?.photo;
  if (!photos?.length) throw new Error("No photo was attached.");
  const largestPhoto = photos[photos.length - 1]!;
  const downloaded = await downloadTelegramFile(ctx.api, largestPhoto.file_id);
  return { buffer: downloaded.buffer, mimeType: "image/jpeg" };
}

export async function downloadRepliedPhoto(ctx: Context): Promise<{ buffer: Buffer; mimeType: string }> {
  const photos = ctx.message?.reply_to_message?.photo;
  if (!photos?.length) throw new Error("Reply to a photo to use /edit.");
  const largestPhoto = photos[photos.length - 1]!;
  const downloaded = await downloadTelegramFile(ctx.api, largestPhoto.file_id);
  return { buffer: downloaded.buffer, mimeType: "image/jpeg" };
}
