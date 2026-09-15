import crypto from "node:crypto";
import path from "node:path";
import type { SessionInfo } from "../types/session.js";
import { getEffectiveCurrentSession } from "./session-service.js";
import { logger } from "../../utils/logger.js";

const VOICE_DIR = path.join(".telegram", "voice");
const MAX_STORED_VOICE_FILES = 20;

/** Keeps the workspace bounded: only the newest voice notes survive. */
async function pruneVoiceDirectory(directory: string): Promise<void> {
  const fs = await import("fs/promises");
  const names = await fs.readdir(directory);
  const files = await Promise.all(
    names.map(async (name) => {
      try {
        const stat = await fs.stat(path.join(directory, name));
        return { name, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    }),
  );
  const sorted = files
    .filter((entry): entry is { name: string; mtimeMs: number } => entry !== null)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const stale of sorted.slice(MAX_STORED_VOICE_FILES)) {
    await fs.rm(path.join(directory, stale.name), { force: true }).catch(() => {});
  }
}

export async function saveTopicVoiceAsset(
  buffer: Buffer,
  originalFilename: string,
  sessionOverride?: SessionInfo | null,
): Promise<{ absolutePath: string; relativePath: string } | null> {
  const session = sessionOverride ?? (await getEffectiveCurrentSession());
  if (!session?.directory) return null;

  const rawExtension = path.extname(originalFilename).replace(/^\./u, "").toLowerCase();
  const extension = /^[a-z0-9.+-]{1,10}$/u.test(rawExtension) ? rawExtension : "ogg";
  const filename = `voice-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${extension}`;
  const relativePath = path.join(VOICE_DIR, filename);
  const absolutePath = path.resolve(session.directory, relativePath);
  const root = path.resolve(session.directory);
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new Error("Refusing to write voice asset outside the Topic workspace");
  }

  const fs = await import("fs/promises");
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, buffer);
  await pruneVoiceDirectory(path.dirname(absolutePath)).catch((error) => logger.warn("[Voice] Failed to prune old voice assets:", error));
  return { absolutePath, relativePath };
}
