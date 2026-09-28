import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getRuntimePaths } from "../../runtime/paths.js";
import { logger } from "../../utils/logger.js";

const ROOT = "extension-automation";

function rootDir(): string {
  return path.join(getRuntimePaths().runDirPath, ROOT);
}

function addIntentDir(): string {
  return path.join(rootDir(), "add-intents");
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

export function clearSharedExtensionAutomationState(): void {
  try { fs.rmSync(rootDir(), { recursive: true, force: true }); } catch {}
}
