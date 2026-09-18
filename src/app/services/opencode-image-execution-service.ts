import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { opencodeClient } from "../../opencode/client.js";
import type { ImageBinary, ImageModelSelection } from "../types/image-model.js";
import { detectImageMimeType, validateImage } from "./ai-http-service.js";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function dataUrl(source: ImageBinary): string {
  return `data:${source.mimeType};base64,${source.buffer.toString("base64")}`;
}

async function imageFromUrl(
  url: string,
  mime: string,
  worktree: string,
  signal: AbortSignal,
): Promise<ImageBinary> {
  let buffer: Buffer;

  if (url.startsWith("data:")) {
    const match = url.match(/^data:([^;,]+);base64,(.+)$/s);
    if (!match) throw new Error("OpenCode image model returned an invalid data URL.");
    buffer = Buffer.from(match[2]!, "base64");
    mime = match[1]!;
  } else if (url.startsWith("file:")) {
    const filePath = fileURLToPath(url);
    const relative = path.relative(path.resolve(worktree), path.resolve(filePath));
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("OpenCode image model returned a file outside the Topic worktree.");
    }
    buffer = await fs.readFile(filePath);
  } else if (/^https?:\/\//i.test(url)) {
    const response = await fetch(url, { signal, redirect: "follow" });
    if (!response.ok) throw new Error(`OpenCode image download failed: HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
      throw new Error("OpenCode image output exceeds the 20 MB limit.");
    }
    buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_IMAGE_BYTES) throw new Error("OpenCode image output exceeds the 20 MB limit.");
    mime = response.headers.get("content-type")?.split(";")[0]?.trim() || mime;
  } else {
    throw new Error("OpenCode image model returned an unsupported file URL.");
  }

  if (buffer.length > MAX_IMAGE_BYTES) throw new Error("OpenCode image output exceeds the 20 MB limit.");
  const detected = detectImageMimeType(buffer);
  if (!detected) throw new Error("OpenCode image model returned unsupported image bytes.");
  const result = { buffer, mimeType: detected || mime };
  validateImage(result.buffer, result.mimeType);
  return result;
}

export async function runOpenCodeImageModel(
  selection: ImageModelSelection,
  prompt: string,
  source: ImageBinary | undefined,
  signal: AbortSignal,
  worktree: string,
): Promise<ImageBinary> {
  signal.throwIfAborted();
  const created = await opencodeClient.session.create({
    directory: worktree,
    title: "Image AI action",
    model: { providerID: selection.providerID, id: selection.modelID },
  });

  if (created.error || !created.data?.id) {
    throw new Error("OpenCode could not create a temporary image session.");
  }

  const sessionID = created.data.id;
  try {
    const parts: Array<
      { type: "text"; text: string }
      | { type: "file"; mime: string; filename: string; url: string }
    > = [
      {
        type: "text",
        text: source
          ? `Edit the attached image exactly as requested. Return one final image.\n\nInstruction: ${prompt}`
          : `Generate one image from this instruction and return the final image.\n\nInstruction: ${prompt}`,
      },
    ];
    if (source) {
      parts.push({
        type: "file",
        mime: source.mimeType,
        filename: "reference-image",
        url: dataUrl(source),
      });
    }

    signal.throwIfAborted();
    const response = await opencodeClient.session.prompt({
      sessionID,
      directory: worktree,
      model: { providerID: selection.providerID, modelID: selection.modelID },
      tools: {},
      system: "You are an image generation/editing endpoint. Return a final image file part. Do not invoke tools.",
      parts,
    }, { signal } as never);

    if (response.error || !response.data) {
      throw new Error("OpenCode image model request failed.");
    }

    const imagePart = response.data.parts.find((part) =>
      part.type === "file"
      && typeof part.mime === "string"
      && part.mime.startsWith("image/")
      && typeof part.url === "string");

    if (!imagePart || imagePart.type !== "file") {
      throw new Error("The selected model returned no image output.");
    }

    return await imageFromUrl(imagePart.url, imagePart.mime, worktree, signal);
  } finally {
    await opencodeClient.session.delete({ sessionID, directory: worktree }).catch(() => {});
  }
}