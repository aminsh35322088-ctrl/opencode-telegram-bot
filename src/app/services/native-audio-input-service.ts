import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ModelExecutionCapabilities } from "../types/model-capability.js";
import { nativeAudioTransportAccepts } from "./model-execution-capability-service.js";
import { logger } from "../../utils/logger.js";

const execFileAsync = promisify(execFile);
const FFMPEG_TIMEOUT_MS = 30_000;

export interface PreparedNativeAudioInput {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  transcoded: boolean;
}

function normalizeMime(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  if (normalized === "audio/mp3") return "audio/mpeg";
  return normalized;
}

function preferredTarget(execution: ModelExecutionCapabilities): "audio/wav" | "audio/mpeg" | null {
  const types = execution.nativeAudioMimeTypes.map(normalizeMime);
  if (types.includes("audio/wav")) return "audio/wav";
  if (types.includes("audio/mpeg")) return "audio/mpeg";
  return null;
}

/**
 * Prepares Telegram audio for a verified native-audio transport.
 * Unknown/unverified transports return null and must fall back to STT.
 */
export async function prepareNativeAudioInput(
  buffer: Buffer,
  filename: string,
  mimeType: string,
  execution: ModelExecutionCapabilities | undefined,
): Promise<PreparedNativeAudioInput | null> {
  if (!execution || execution.nativeAudioFileInput !== true) return null;
  const normalizedMime = normalizeMime(mimeType);
  if (nativeAudioTransportAccepts(execution, normalizedMime) || execution.nativeAudioMimeTypes.includes("audio/*")) {
    return { buffer, filename, mimeType: normalizedMime, transcoded: false };
  }

  const target = preferredTarget(execution);
  if (!target) return null;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "otb-native-audio-"));
  try {
    const inputExt = path.extname(filename) || ".audio";
    const input = path.join(dir, `input${inputExt}`);
    const output = path.join(dir, target === "audio/wav" ? "audio.wav" : "audio.mp3");
    await fs.writeFile(input, buffer);
    const args = target === "audio/wav"
      ? ["-v", "error", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", output]
      : ["-v", "error", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "64k", output];
    await execFileAsync("ffmpeg", args, { timeout: FFMPEG_TIMEOUT_MS });
    const converted = await fs.readFile(output);
    if (!converted.length) return null;
    return { buffer: converted, filename: path.basename(output), mimeType: target, transcoded: true };
  } catch (error) {
    logger.warn("[Voice] Native audio normalization failed; STT fallback will be used:", error);
    return null;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}