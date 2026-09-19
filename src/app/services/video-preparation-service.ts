import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { logger } from "../../utils/logger.js";

const execFileAsync = promisify(execFile);
const MAX_FRAMES = 12;
const FRAME_WIDTH = 512;
const FFMPEG_TIMEOUT_MS = 60_000;
const FFPROBE_TIMEOUT_MS = 15_000;

export interface ExtractedVideoFrame { filename: string; buffer: Buffer; }

/** Samples up to 12 evenly spaced frames (max 1 fps), downscaled for multimodal model input. */
export async function extractVideoFrames(videoBuffer: Buffer, sourceFilename: string): Promise<ExtractedVideoFrame[]> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "otb-video-"));
  try {
    const extension = path.extname(sourceFilename) || ".mp4";
    const inputPath = path.join(dir, `input${extension}`);
    await fs.writeFile(inputPath, videoBuffer);
    let durationSec = 0;
    try {
      const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", inputPath], { timeout: FFPROBE_TIMEOUT_MS });
      durationSec = Number.parseFloat(stdout.trim()) || 0;
    } catch { durationSec = 0; }
    const fps = durationSec > 0 ? Math.min(1, MAX_FRAMES / durationSec) : 1;
    await execFileAsync("ffmpeg", ["-v", "error", "-i", inputPath, "-vf", `fps=${fps.toFixed(4)},scale=${FRAME_WIDTH}:-2`, "-frames:v", String(MAX_FRAMES), "-q:v", "4", path.join(dir, "frame-%02d.jpg")], { timeout: FFMPEG_TIMEOUT_MS });
    const names = (await fs.readdir(dir)).filter((name) => /^frame-\d+\.jpg$/u.test(name)).sort();
    const frames: ExtractedVideoFrame[] = [];
    for (const name of names) frames.push({ filename: name, buffer: await fs.readFile(path.join(dir, name)) });
    if (!frames.length) throw new Error("No frames could be extracted from the video");
    return frames;
  } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

/** Extracts a video's audio track as OGG; returns null when no usable audio track exists. */
export async function extractVideoAudio(videoBuffer: Buffer, sourceFilename: string): Promise<{ buffer: Buffer; filename: string } | null> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "otb-video-audio-"));
  try {
    const extension = path.extname(sourceFilename) || ".mp4";
    const inputPath = path.join(dir, `input${extension}`);
    const outputPath = path.join(dir, "audio.ogg");
    await fs.writeFile(inputPath, videoBuffer);
    await execFileAsync("ffmpeg", ["-v", "error", "-i", inputPath, "-vn", "-acodec", "libvorbis", "-q:a", "4", outputPath], { timeout: FFMPEG_TIMEOUT_MS });
    const buffer = await fs.readFile(outputPath);
    return buffer.length ? { buffer, filename: "audio.ogg" } : null;
  } catch (error) {
    logger.warn("[Video] Failed to extract audio from video:", error);
    return null;
  } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}