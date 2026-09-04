import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { logger } from "../../utils/logger.js";

const WORKSPACE_ROOT_ENV = "OPENCODE_TOPIC_WORKSPACES_DIR";
const SOURCE_ROOT_ENV = "OPENCODE_TOPIC_SOURCE_DIR";
function getSourceRoot(): string { return path.resolve(process.env[SOURCE_ROOT_ENV]?.trim() || process.cwd()); }
function getWorkspaceRoot(): string { const configured = process.env[WORKSPACE_ROOT_ENV]?.trim(); return path.resolve(configured || path.join(os.tmpdir(), "opencode-telegram-topic-workspaces")); }
function workspacePath(chatId: number, sessionId: string): string { return path.join(getWorkspaceRoot(), String(chatId), sessionId); }

// Runtime/secret files belong to the bot host, never to a Topic workspace.
// Project source and OpenCode files are copied, while bot metadata, credentials,
// dependency trees and previous Topic workspaces are intentionally excluded.
const EXCLUDED_NAMES = new Set([
  ".git", "node_modules", ".env", ".env.local", ".topic-workspaces",
  "settings.json", "settings.json.bak", "settings.json.tmp",
  "telegram-topic-bindings.json", "telegram-topic-bindings.json.bak",
  "telegram-topic-runtime.json", "telegram-topic-runtime.json.tmp",
  "logs", "run", ".tmp",
]);

export async function createTelegramTopicWorkspace(chatId: number): Promise<string> {
  const fs = await import("fs/promises");
  const sessionId = randomUUID();
  const target = workspacePath(chatId, sessionId);
  const source = getSourceRoot();
  if (path.resolve(source) === path.resolve(target) || target.startsWith(`${source}${path.sep}`)) throw new Error(`Refusing to create topic workspace inside source root: ${target}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.cp(source, target, { recursive: true, force: false, errorOnExist: true, filter: (sourcePath) => !EXCLUDED_NAMES.has(path.basename(sourcePath)) });
    logger.info(`[TelegramTopics] Created isolated workspace: chat=${chatId}, directory=${target}`);
    return target;
  } catch (error) { await fs.rm(target, { recursive: true, force: true }).catch(() => {}); throw error; }
}

function assertManagedWorkspace(directory: string): string {
  const root = path.resolve(getWorkspaceRoot());
  const resolved = path.resolve(directory);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Refusing to delete non-topic workspace: ${directory}`);
  const segments = relative.split(path.sep);
  const [chatIdSegment, sessionIdSegment] = segments;
  if (segments.length !== 2 || !chatIdSegment || !sessionIdSegment || !/^[-]?\d+$/.test(chatIdSegment)) throw new Error(`Refusing to delete malformed topic workspace: ${directory}`);
  return resolved;
}
export async function deleteTelegramTopicWorkspace(directory: string): Promise<void> { const fs = await import("fs/promises"); const managedDirectory = assertManagedWorkspace(directory); await fs.rm(managedDirectory, { recursive: true, force: true }); logger.info(`[TelegramTopics] Deleted isolated workspace: directory=${managedDirectory}`); }
export function isTelegramTopicWorkspace(directory: string): boolean { try { assertManagedWorkspace(directory); return true; } catch { return false; } }
