import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tool } from "@opencode-ai/plugin";

const MEDIA_ACTIONS = [
  "stt.status",
  "stt.transcribe",
  "image.providers",
  "image.profile",
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
interface ImageProviderModule {
  listImageAiProviders(): Promise<unknown[]>;
}
interface ImageProfileModule {
  resolveDefaultImageChatProfile(): Promise<{ profile: unknown; source: "auto" | "manual"; selection: string }>;
}
interface ImageEngineModule {
  runImageChatEngine(
    profile: unknown,
    turns: Array<{ role: "user" | "model"; parts: Array<{ text?: string; image?: { fileID: string; mimeType: string } }> }>,
    reference: { fileID: string; mimeType: string } | undefined,
    load: (reference: { fileID: string; mimeType: string }, signal: AbortSignal) => Promise<{ buffer: Buffer; mimeType: string }>,
    signal: AbortSignal,
  ): Promise<Array<{ text?: string; image?: { buffer: Buffer; mimeType: string }; thought?: boolean }>>;
}
interface AiHttpModule {
  detectImageMimeType(buffer: Buffer): string | null;
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
    "Use the bot's configured audio transcription and Image Chat engines through explicit actions. Credentials stay inside the bot. Input/output files are restricted to the current worktree.",
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
      if (stat.size > MAX_AUDIO_BYTES) throw new Error(`Audio file exceeds the ${MAX_AUDIO_BYTES} byte agent limit.`);
      const service = await load<SttModule>("app/services/stt-service.js");
      const result = await service.transcribeAudio(await fs.readFile(filePath), path.basename(filePath));
      return JSON.stringify(result, null, 2);
    }

    if (action === "image.providers") {
      const service = await load<ImageProviderModule>("app/services/image-ai-provider-service.js");
      return JSON.stringify(await service.listImageAiProviders(), null, 2).slice(0, 30000);
    }

    const profileService = await load<ImageProfileModule>("app/services/image-chat-profile-service.js");
    const resolved = await profileService.resolveDefaultImageChatProfile();
    if (action === "image.profile") {
      return JSON.stringify(resolved, null, 2).slice(0, 30000);
    }

    const prompt = required(args.prompt, "prompt", action);
    const engine = await load<ImageEngineModule>("app/services/image-chat-engine.js");
    const aiHttp = await load<AiHttpModule>("app/services/ai-http-service.js");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180_000);

    let reference: { fileID: string; mimeType: string } | undefined;
    if (action === "image.edit") {
      const rawPath = required(args.path, "path", action);
      const filePath = resolveWorktreePath(context.worktree, rawPath);
      const buffer = await fs.readFile(filePath);
      const mimeType = aiHttp.detectImageMimeType(buffer);
      if (!mimeType) throw new Error("Reference file is not a supported image.");
      reference = { fileID: filePath, mimeType };
    }

    try {
      const turns = [{
        role: "user" as const,
        parts: [
          { text: prompt },
          ...(reference ? [{ image: reference }] : []),
        ],
      }];
      const parts = await engine.runImageChatEngine(
        resolved.profile,
        turns,
        reference,
        async (item) => {
          const buffer = await fs.readFile(item.fileID);
          const mimeType = aiHttp.detectImageMimeType(buffer);
          if (!mimeType) throw new Error("Reference file is not a supported image.");
          return { buffer, mimeType };
        },
        controller.signal,
      );
      const imagePart = parts.find((part) => part.image)?.image;
      const text = parts.filter((part) => !part.thought && part.text).map((part) => part.text).join("\n").trim();
      if (!imagePart) throw new Error("Image engine returned no image for this request.");

      const requestedOutput = args.output?.trim() || `artifacts/image-${Date.now()}`;
      const outputPath = resolveWorktreePath(
        context.worktree,
        path.extname(requestedOutput) ? requestedOutput : `${requestedOutput}${extensionForMime(imagePart.mimeType)}`,
      );
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, imagePart.buffer);
      return JSON.stringify({ ok: true, path: outputPath, mimeType: imagePart.mimeType, text, profile: resolved.selection }, null, 2);
    } finally {
      clearTimeout(timer);
    }
  },
});
