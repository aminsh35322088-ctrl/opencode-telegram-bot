import path from "node:path";
import { getRuntimePaths } from "../../runtime/paths.js";

interface MainTopicBinding {
  chatId: number;
  threadId: number;
  title: string;
  createdAt: string;
}

function getStorePath(): string {
  return path.join(path.dirname(getRuntimePaths().settingsFilePath), "telegram-main-topic.json");
}

function isFileNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function getMainTelegramTopic(chatId: number): Promise<MainTopicBinding | null> {
  const fs = await import("fs/promises");
  try {
    const raw = await fs.readFile(getStorePath(), "utf8");
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const binding = value as Partial<MainTopicBinding>;
    if (binding.chatId !== chatId || typeof binding.threadId !== "number") return null;
    return {
      chatId,
      threadId: binding.threadId,
      title: typeof binding.title === "string" ? binding.title : "General",
      createdAt: typeof binding.createdAt === "string" ? binding.createdAt : new Date(0).toISOString(),
    };
  } catch (error) {
    if (isFileNotFound(error)) return null;
    throw error;
  }
}

export async function saveMainTelegramTopic(chatId: number, threadId: number, title = "General"): Promise<void> {
  const fs = await import("fs/promises");
  const storePath = getStorePath();
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify({ chatId, threadId, title, createdAt: new Date().toISOString() }, null, 2), "utf8");
}
