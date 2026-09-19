import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tool } from "@opencode-ai/plugin";

const MEDIA_ACTIONS = [
  "stt.status",
  "stt.transcribe",
  "video.prepare",
  "image.providers",
  "image.models",
  "image.current",
  "image.generate",
  "image.edit",
] as const;

const DIST_ROOT = process.env.AGENT_BOT_DIST_ROOT?.trim() || "/app/dist";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

type MediaAction = (typeof MEDIA_ACTIONS)[number];

interface SttModule {
  isSttConfigured(): Promise<boolean>;
  transcribeAudio(audioBuffer: Buffer, filename: string): Promise<{ text: string; uncertain?: boolean }>;
}
interface ImageCatalogModule {
  listImageModelCatalog(): Promise<unknown[]>;
}
interface ImageResolutionModule {
  resolvePersistedImageModel(worktree?: string): Promise<unknown>;
}
interface ImageActionModule {
  generateConfiguredImage(prompt: string, signal?: AbortSignal, worktree?: string): Promise<{ buffer: Buffer; mimeType: string }>;
  editConfiguredImage(
    prompt: string,
    source: { buffer: Buffer; mimeType: string },
    signal?: AbortSignal,
    worktree?: string,
  ): Promise<{ buffer: Buffer; mimeType: string }>;
}
interface AiHttpModule {
  detectImageMimeType(buffer: Buffer): string | null;
}
interface VideoPreparationModule {
  extractVideoFrames(buffer: Buffer, filename: string): Promise<Array<{ filename: string; buffer: Buffer }>>;
  extractVideoAudio(buffer: Buffer, filename: string): Promise<{ buffer: Buffer; filename: string } | null>;
}

async function load<T>(relativePath: string): Promise<T> {
  return import(pathToFileURL(path.join(DIST_ROOT, relativePath)).href) as Promise<T>;
}

function required(value: string | undefined, field: string, action: MediaAction): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${action} requires ${field}`);
  return normalized;
}

function resolveWorktreePath(worktree: string, raw: string): string {
  const target = path.resolve(worktree, raw);
  const relative = path.relative(worktree, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Media paths must stay inside the current worktree.");
  }
  return target;
}

function extensionForMime(mimeType: string): string {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/gif") return ".gif";
  return ".png";
}

export default tool({
  description:
    "Use the bot's configured STT and Image AI capabilities. Image generation/editing always uses the effective Image Model selected in Main Settings or overridden for this AI Topic. Credentials and provider/model resolution stay server-side.",
  args: {
    action: tool.schema.enum(MEDIA_ACTIONS).describe("Media action to execute."),
    path: tool.schema.string().optional().describe("Worktree-relative audio or reference-image path."),
    prompt: tool.schema.string().optional().describe("Image generation/edit instruction."),
    output: tool.schema.string().optional().describe("Worktree-relative output image path. Extension is inferred when omitted."),
  },
  async execute(args, context) {
    const action = args.action as MediaAction;

    if (action === "stt.status") {
      const service = await load<SttModule>("app/services/stt-service.js");
      return JSON.stringify({ configured: await service.isSttConfigured() }, null, 2);
    }

    if (action === "stt.transcribe") {
      const rawPath = required(args.path, "path", action);
      const filePath = resolveWorktreePath(context.worktree, rawPath);
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) throw new Error("Audio path is not a regular file.");
      if (stat.size > MAX_AUDIO_BYTES) {
        throw new Error(`Audio file exceeds the ${MAX_AUDIO_BYTES} byte agent limit.`);
      }
      const service = await load<SttModule>("app/services/stt-service.js");
      return JSON.stringify(
        await service.transcribeAudio(await fs.readFile(filePath), path.basename(filePath)),
        null,
        2,
      );
    }

    if (action === "video.prepare") {
      const rawPath = required(args.path, "path", action);
      const filePath = resolveWorktreePath(context.worktree, rawPath);
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) throw new Error("Video path is not a regular file.");
      if (stat.size > 20 * 1024 * 1024) throw new Error("Video exceeds the 20 MB preparation limit.");
      const source = await fs.readFile(filePath);
      const service = await load<VideoPreparationModule>("app/services/video-preparation-service.js");
      const frames = await service.extractVideoFrames(source, path.basename(filePath));
      const audio = await service.extractVideoAudio(source, path.basename(filePath));
      const requestedOutput = args.output?.trim() || `artifacts/video-${Date.now()}`;
      const outputDir = resolveWorktreePath(context.worktree, requestedOutput);
      await fs.mkdir(outputDir, { recursive: true });
      const framePaths: string[] = [];
      for (const frame of frames) {
        const framePath = path.join(outputDir, frame.filename);
        await fs.writeFile(framePath, frame.buffer);
        framePaths.push(framePath);
      }
      let audioPath: string | null = null;
      if (audio) {
        audioPath = path.join(outputDir, audio.filename);
        await fs.writeFile(audioPath, audio.buffer);
      }
      return JSON.stringify({ ok: true, source: filePath, frames: framePaths, audio: audioPath }, null, 2);
    }

    if (action === "image.providers" || action === "image.models") {
      const catalog = await load<ImageCatalogModule>("app/services/image-model-catalog-service.js");
      return JSON.stringify(await catalog.listImageModelCatalog(), null, 2).slice(0, 30000);
    }

    if (action === "image.current") {
      const resolver = await load<ImageResolutionModule>("app/services/image-model-resolution-service.js");
      return JSON.stringify({
        selection: await resolver.resolvePersistedImageModel(context.worktree) ?? null,
      }, null, 2);
    }

    const prompt = required(args.prompt, "prompt", action);
    const imageService = await load<ImageActionModule>("app/services/image-action-service.js");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180_000);

    try {
      let result: { buffer: Buffer; mimeType: string };
      if (action === "image.edit") {
        const rawPath = required(args.path, "path", action);
        const filePath = resolveWorktreePath(context.worktree, rawPath);
        const buffer = await fs.readFile(filePath);
        const aiHttp = await load<AiHttpModule>("app/services/ai-http-service.js");
        const mimeType = aiHttp.detectImageMimeType(buffer);
        if (!mimeType) throw new Error("Reference file is not a supported image.");
        result = await imageService.editConfiguredImage(
          prompt,
          { buffer, mimeType },
          controller.signal,
          context.worktree,
        );
      } else {
        result = await imageService.generateConfiguredImage(
          prompt,
          controller.signal,
          context.worktree,
        );
      }

      const requestedOutput = args.output?.trim() || `artifacts/image-${Date.now()}`;
      const outputPath = resolveWorktreePath(
        context.worktree,
        path.extname(requestedOutput)
          ? requestedOutput
          : requestedOutput + extensionForMime(result.mimeType),
      );
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, result.buffer);

      const resolver = await load<ImageResolutionModule>("app/services/image-model-resolution-service.js");
      return JSON.stringify({
        ok: true,
        path: outputPath,
        mimeType: result.mimeType,
        selection: await resolver.resolvePersistedImageModel(context.worktree) ?? null,
      }, null, 2);
    } finally {
      clearTimeout(timer);
    }
  },
});
