import crypto from "node:crypto";
import path from "node:path";
import type { SessionInfo } from "./session-service.js";
import { getCurrentSession } from "./session-service.js";

const IMAGE_DIR = path.join(".telegram", "image-ai");

export async function saveTopicImageAsset(
  buffer: Buffer,
  mimeType: string,
  kind: "generated" | "edited",
  sessionOverride?: SessionInfo,
): Promise<{ absolutePath: string; relativePath: string } | null> {
  const session = sessionOverride ?? getCurrentSession();
  if (!session?.directory) return null;

  const extension = mimeType.split("/")[1]?.split(";")[0]?.toLowerCase() || "png";
  const safeExtension = /^[a-z0-9.+-]+$/u.test(extension) ? extension : "png";
  const filename = `${kind}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${safeExtension}`;
  const relativePath = path.join(IMAGE_DIR, filename);
  const absolutePath = path.resolve(session.directory, relativePath);
  const root = path.resolve(session.directory);
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new Error("Refusing to write Image AI asset outside the Topic workspace");
  }

  const fs = await import("fs/promises");
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, buffer);
  return { absolutePath, relativePath };
}
