import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { logger } from "../../utils/logger.js";

const WORKSPACE_ROOT_ENV = "OPENCODE_TOPIC_WORKSPACES_DIR";
const SOURCE_ROOT_ENV = "OPENCODE_TOPIC_SOURCE_DIR";
function getSourceRoot(): string { return path.resolve(process.env[SOURCE_ROOT_ENV]?.trim() || process.cwd()); }
function getWorkspaceRoot(): string {
  const configured = process.env[WORKSPACE_ROOT_ENV]?.trim();
  if (configured) return path.resolve(configured);
  const persistentRoot = process.env.OPENCODE_TELEGRAM_HOME?.trim() || (process.env.RAILWAY_ENVIRONMENT ? "/data" : null);
  return path.resolve(persistentRoot ? path.join(persistentRoot, "opencode", "topic-workspaces") : path.join(os.tmpdir(), "opencode-telegram-topic-workspaces"));
}
function workspacePath(chatId: number, sessionId: string): string { return path.join(getWorkspaceRoot(), String(chatId), sessionId); }
const EXCLUDED_NAMES = new Set([".git", "node_modules", ".env", ".env.local", ".topic-workspaces", "settings.json", "settings.json.bak", "settings.json.tmp", "telegram-topic-bindings.json", "telegram-topic-bindings.json.bak", "telegram-topic-runtime.json", "telegram-topic-runtime.json.tmp", "logs", "run", ".tmp"]);
export async function createTelegramTopicWorkspace(chatId: number): Promise<string> {
  const fs = await import("fs/promises"); const sessionId = randomUUID(); const target = workspacePath(chatId, sessionId); const source = getSourceRoot();
  if (path.resolve(source) === path.resolve(target) || target.startsWith(`${source}${path.sep}`)) throw new Error(`Refusing to create topic workspace inside source root: ${target}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  try { await fs.cp(source, target, { recursive: true, force: false, errorOnExist: true, filter: (sourcePath) => !EXCLUDED_NAMES.has(path.basename(sourcePath)) }); logger.info(`[TelegramTopics] Created isolated workspace: chat=${chatId}, directory=${target}`); return target; }
  catch (error) { await fs.rm(target, { recursive: true, force: true }).catch(() => {}); throw error; }
}
function assertManagedWorkspace(directory: string): string {
  const root = path.resolve(getWorkspaceRoot()); const resolved = path.resolve(directory); const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Refusing to delete non-topic workspace: ${directory}`);
  const segments = relative.split(path.sep); const [chatIdSegment, sessionIdSegment] = segments;
  if (segments.length !== 2 || !chatIdSegment || !sessionIdSegment || !/^[-]?\d+$/.test(chatIdSegment)) throw new Error(`Refusing to delete malformed topic workspace: ${directory}`);
  return resolved;
}
export async function deleteTelegramTopicWorkspace(directory: string): Promise<void> { const fs = await import("fs/promises"); const managedDirectory = assertManagedWorkspace(directory); await fs.rm(managedDirectory, { recursive: true, force: true }); logger.info(`[TelegramTopics] Deleted isolated workspace: directory=${managedDirectory}`); }
export function isTelegramTopicWorkspace(directory: string): boolean { try { assertManagedWorkspace(directory); return true; } catch { return false; } }
export function getTelegramTopicWorkspaceRoot(): string { return getWorkspaceRoot(); }

/**
 * Deletes every managed topic workspace directory that is not referenced by the
 * given (live) binding directories. Runs after topic deletes and during resets
 * and startup so a failed or interrupted delete can never orphan a workspace
 * (and its full repo copy) on the persistent volume.
 */
export async function reconcileTopicWorkspaces(referencedDirectories: ReadonlySet<string>): Promise<string[]> {
  const fs = await import("fs/promises");
  const root = path.resolve(getWorkspaceRoot());
  const referenced = new Set([...referencedDirectories].map((directory) => path.resolve(directory)));
  const removed: string[] = [];
  let chatEntries: import("fs").Dirent[];
  try { chatEntries = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return removed; throw error; }
  for (const chatEntry of chatEntries) {
    if (!chatEntry.isDirectory() || !/^[-]?\d+$/.test(chatEntry.name)) continue;
    const chatDir = path.join(root, chatEntry.name);
    let sessionEntries: import("fs").Dirent[];
    try { sessionEntries = await fs.readdir(chatDir, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory()) continue;
      const workspaceDir = path.join(chatDir, sessionEntry.name);
      let managed: string;
      try { managed = assertManagedWorkspace(workspaceDir); }
      catch { logger.warn(`[TelegramTopics] Skipping unmanaged workspace path during reconcile: ${workspaceDir}`); continue; }
      if (referenced.has(managed)) continue;
      await fs.rm(managed, { recursive: true, force: true });
      removed.push(managed);
      logger.info(`[TelegramTopics] Reconciled orphaned workspace: directory=${managed}`);
    }
    try {
      const remaining = await fs.readdir(chatDir);
      if (remaining.length === 0) await fs.rmdir(chatDir);
    } catch { /* chat dir already gone or not removable */ }
  }
  return removed;
}
