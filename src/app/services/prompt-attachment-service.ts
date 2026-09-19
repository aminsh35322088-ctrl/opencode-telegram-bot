import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { FilePartInput } from "@opencode-ai/sdk/v2";
import { config } from "../../config.js";
import { promptAttachment, type PendingAttachment } from "../managers/prompt-attachment-manager.js";
import { logger } from "../../utils/logger.js";
import { isFileSizeAllowed } from "./file-download-service.js";
import { isWithinProjectRootSafe } from "./file-browser-service.js";

const OPENCODE_TEXT_MIME = "text/plain";

async function resolveOne(pending: PendingAttachment, worktree: string): Promise<FilePartInput | null> {
  const { absolutePath } = pending;
  if (pending.worktree !== worktree) { logger.warn(`[PromptAttachment] Dropping attachment: project changed, attached=${pending.worktree}, current=${worktree}`); return null; }
  let stat;
  try { stat = await fs.stat(absolutePath); }
  catch (error) { logger.warn(`[PromptAttachment] Dropping attachment: cannot stat ${absolutePath}`, error); return null; }
  if (!stat.isFile()) { logger.warn(`[PromptAttachment] Dropping attachment: not a file anymore: ${absolutePath}`); return null; }
  if (!isFileSizeAllowed(stat.size, config.files.maxFileSizeKb)) { logger.warn(`[PromptAttachment] Dropping attachment: too large: ${absolutePath} (${stat.size} bytes > ${config.files.maxFileSizeKb}KB)`); return null; }
  if (!(await isWithinProjectRootSafe(absolutePath))) { logger.warn(`[PromptAttachment] Dropping attachment: outside project root: ${absolutePath}`); return null; }
  return { type: "file", mime: pending.mimeType ?? OPENCODE_TEXT_MIME, filename: toRelativePath(absolutePath, worktree), url: pathToFileURL(absolutePath).href };
}

export async function resolvePendingAttachments(worktree: string): Promise<FilePartInput[]> {
  const pending = promptAttachment.getAll();
  if (!pending.length) return [];
  const resolved = await Promise.all(pending.map((item) => resolveOne(item, worktree)));
  if (resolved.some((item) => item === null)) { promptAttachment.clear("attachment_invalid"); return []; }
  return resolved as FilePartInput[];
}

/** Backward-compatible single-attachment resolver. */
export async function resolvePendingAttachment(worktree: string): Promise<FilePartInput | null> {
  return (await resolvePendingAttachments(worktree))[0] ?? null;
}

export function toRelativePath(absolutePath: string, worktree: string): string {
  const relative = path.relative(worktree, absolutePath);
  return relative && !relative.startsWith("..") ? relative : absolutePath;
}