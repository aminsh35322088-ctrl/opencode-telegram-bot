import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getRuntimePaths } from "../../runtime/paths.js";
import { logger } from "../../utils/logger.js";
import type { ExtensionEnsureRequest } from "../types/extension.js";

const ROOT = "extension-automation";

function rootDir(): string {
  return path.join(getRuntimePaths().runDirPath, ROOT);
}

function addIntentDir(): string {
  return path.join(rootDir(), "add-intents");
}

function ensureRequestDir(): string {
  return path.join(rootDir(), "ensure-requests");
}

function sessionKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function atomicWrite(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch {}
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch {}
  }
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(`[Extensions] Could not read shared automation state: ${filePath}`);
    }
    return null;
  }
}

function addIntentPath(sessionId: string): string {
  return path.join(addIntentDir(), `${sessionKey(sessionId)}.json`);
}

export function writeSharedPendingAdd<T extends { sessionId: string }>(value: T): void {
  atomicWrite(addIntentPath(value.sessionId), value);
}

export function readSharedPendingAdd<T>(sessionId: string): T | null {
  return readJson<T>(addIntentPath(sessionId));
}

export function claimSharedPendingAdd<T>(sessionId: string): T | null {
  const source = addIntentPath(sessionId);
  const claimed = `${source}.claimed`;
  try {
    ensureDir(path.dirname(source));
    fs.renameSync(source, claimed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(`[Extensions] Could not claim shared add intent: session=${sessionId}`);
    }
    return null;
  }
  try {
    return readJson<T>(claimed);
  } finally {
    try { fs.rmSync(claimed, { force: true }); } catch {}
  }
}

export function removeSharedPendingAdd(sessionId: string): void {
  try { fs.rmSync(addIntentPath(sessionId), { force: true }); } catch {}
}

function ensureRequestPath(requestId: string): string {
  // Request IDs are generated server-side; keep them to a safe filename shape so
  // a crafted value can never escape the directory.
  const safe = requestId.replace(/[^a-zA-Z0-9-]/gu, "");
  if (!safe) throw new Error("Extension approval request id is invalid.");
  return path.join(ensureRequestDir(), `${safe}.json`);
}

/**
 * Plugin approval requests are created by the OpenCode server process (the bot
 * tool runs there) and must be presented, approved, or cancelled by the Telegram
 * bot process. In-memory state cannot cross that boundary, so requests are
 * persisted here and claimed by rename, which makes approval single-shot even if
 * both processes race on the same callback.
 */
export function writeSharedEnsureRequest(value: ExtensionEnsureRequest): void {
  atomicWrite(ensureRequestPath(value.id), value);
}

export function readSharedEnsureRequest(requestId: string): ExtensionEnsureRequest | null {
  return readJson<ExtensionEnsureRequest>(ensureRequestPath(requestId));
}

export function claimSharedEnsureRequest(requestId: string): ExtensionEnsureRequest | null {
  const source = ensureRequestPath(requestId);
  const claimed = `${source}.claimed`;
  try {
    ensureDir(path.dirname(source));
    fs.renameSync(source, claimed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(`[Extensions] Could not claim shared approval request: id=${requestId}`);
    }
    return null;
  }
  try {
    return readJson<ExtensionEnsureRequest>(claimed);
  } finally {
    try { fs.rmSync(claimed, { force: true }); } catch {}
  }
}

export function removeSharedEnsureRequest(requestId: string): void {
  try { fs.rmSync(ensureRequestPath(requestId), { force: true }); } catch {}
}

export function listSharedEnsureRequests(sessionId: string): ExtensionEnsureRequest[] {
  const requests: ExtensionEnsureRequest[] = [];
  let files: string[];
  try {
    files = fs.readdirSync(ensureRequestDir());
  } catch {
    return requests;
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const request = readJson<ExtensionEnsureRequest>(path.join(ensureRequestDir(), file));
    if (request && request.sessionId === sessionId && request.status === "awaiting-approval") {
      requests.push(request);
    }
  }
  return requests;
}

export function clearSharedExtensionAutomationState(): void {
  try { fs.rmSync(rootDir(), { recursive: true, force: true }); } catch {}
}
