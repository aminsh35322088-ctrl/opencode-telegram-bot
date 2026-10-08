import type { CloudTelegram } from "./telegram.js";
export type CloudPromptPart =
  { type: "text"; text: string } | { type: "file"; mime: string; filename: string; url: string };
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
/** Download bytes in the privileged Telegram boundary; no token-bearing URL crosses RPC. */
export async function telegramMediaParts(
  telegram: CloudTelegram,
  message: {
    photo?: unknown[];
    document?: unknown;
    voice?: unknown;
    audio?: unknown;
    caption?: string;
  },
): Promise<CloudPromptPart[]> {
  const image = message.photo?.filter((p) => Number(object(p).file_size ?? 0) <= 262144).at(-1);
  const candidate = image ?? message.document ?? message.voice ?? message.audio;
  if (!candidate) throw new Error("media_too_large");
  const file = object(candidate);
  if (typeof file.file_id !== "string" || file.file_id.length > 512)
    throw new Error("invalid_telegram_file");
  if (Number(file.file_size ?? 0) > 262144) throw new Error("media_too_large");
  const downloaded = await telegram.download(file.file_id, 262144);
  const mime = image
    ? "image/jpeg"
    : typeof file.mime_type === "string" && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(file.mime_type)
      ? file.mime_type
      : message.voice
        ? "audio/ogg"
        : "application/octet-stream";
  const filename =
    typeof file.file_name === "string"
      ? file.file_name.replace(/[^\p{L}\p{N}_. -]/gu, "_").slice(0, 128)
      : image
        ? "image.jpg"
        : message.voice
          ? "voice.ogg"
          : "attachment";
  let binary = "";
  for (const byte of downloaded) binary += String.fromCharCode(byte);
  return [
    ...(message.caption?.trim()
      ? [{ type: "text" as const, text: message.caption.slice(0, 20000) }]
      : []),
    { type: "file", mime, filename, url: "data:" + mime + ";base64," + btoa(binary) },
  ];
}
