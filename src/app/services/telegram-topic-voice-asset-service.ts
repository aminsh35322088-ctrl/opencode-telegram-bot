import crypto from "node:crypto";
import path from "node:path";
import type { SessionInfo } from "../types/session.js";
import { getEffectiveCurrentSession } from "./session-service.js";

const VOICE_DIR = path.join(".telegram", "voice");

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
  return { absolutePath, relativePath };
}
