import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getRuntimePaths } from "../../runtime/paths.js";
import { logger } from "../../utils/logger.js";

const ROOT = "extension-automation";

function rootDir(): string {
  return path.join(getRuntimePaths().runDirPath, ROOT);
}

function oauthDir(): string {
  return path.join(rootDir(), "oauth");
}

function credentialDir(): string {
  return path.join(rootDir(), "credentials");
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

function removeFile(filePath: string): void {
  try { fs.rmSync(filePath, { force: true }); } catch {}
}

function oauthPath(sessionId: string): string {
  return path.join(oauthDir(), `${sessionKey(sessionId)}.json`);
}

function credentialPath(challengeId: string): string {
  return path.join(credentialDir(), `${challengeId}.json`);
}

export function writeSharedPendingOAuth<T extends { sessionId: string }>(value: T): void {
  atomicWrite(oauthPath(value.sessionId), value);
}

export function readSharedPendingOAuth<T>(sessionId: string): T | null {
  return readJson<T>(oauthPath(sessionId));
}

export function removeSharedPendingOAuth(sessionId: string): void {
  removeFile(oauthPath(sessionId));
}

export function writeSharedCredentialChallenge<T extends { id: string }>(value: T): void {
  atomicWrite(credentialPath(value.id), value);
}

export function readSharedCredentialChallenge<T>(challengeId: string): T | null {
  return readJson<T>(credentialPath(challengeId));
}

export function removeSharedCredentialChallenge(challengeId: string): void {
  removeFile(credentialPath(challengeId));
}

export function listSharedCredentialChallenges<T>(): T[] {
  try {
    ensureDir(credentialDir());
    return fs.readdirSync(credentialDir())
      .filter((name) => name.endsWith(".json"))
      .map((name) => readJson<T>(path.join(credentialDir(), name)))
      .filter((value): value is T => value !== null);
  } catch {
    return [];
  }
}

export function clearSharedExtensionAutomationState(): void {
  try { fs.rmSync(rootDir(), { recursive: true, force: true }); } catch {}
}
