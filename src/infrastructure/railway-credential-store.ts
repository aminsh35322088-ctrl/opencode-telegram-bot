import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { syncDirectory } from "../utils/sync-directory.js";

export type RailwayInfrastructureTokenType = "account" | "workspace";
export interface StoredRailwayInfrastructureCredential {
  token: string;
  tokenType: RailwayInfrastructureTokenType;
  workspaceId: string;
  workspaceName?: string;
}
interface CredentialEnvelope {
  version: 1;
  tokenType: RailwayInfrastructureTokenType;
  workspaceId: string;
  workspaceName?: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

function bounded(value: string, name: string, max = 4096): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\r\n\u0000]/u.test(normalized)) throw new Error(`Invalid ${name}`);
  return normalized;
}

async function atomicWrite(filename: string, data: string | Buffer): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
  await rename(temporary, filename);
  await chmod(filename, 0o600);
  await syncDirectory(path.dirname(filename));
}

export class RailwayCredentialStore {
  private readonly keyFilename: string;
  constructor(private readonly filename: string) { this.keyFilename = `${filename}.key`; }

  private async key(): Promise<Buffer> {
    try {
      const info = await lstat(this.keyFilename);
      const uid = process.getuid?.();
      if (!info.isFile() || info.isSymbolicLink() || (uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0 || info.size !== 32) throw new Error("Invalid Railway credential key");
      return await readFile(this.keyFilename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const key = randomBytes(32);
      await atomicWrite(this.keyFilename, key);
      return key;
    }
  }

  async save(input: StoredRailwayInfrastructureCredential): Promise<void> {
    const token = bounded(input.token, "Railway token");
    const workspaceId = bounded(input.workspaceId, "Railway workspace id", 256);
    const workspaceName = input.workspaceName === undefined ? undefined : bounded(input.workspaceName, "Railway workspace name", 256);
    if (!(["account", "workspace"] as string[]).includes(input.tokenType)) throw new Error("Invalid Railway token type");
    const key = await this.key();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    const envelope: CredentialEnvelope = {
      version: 1,
      tokenType: input.tokenType,
      workspaceId,
      ...(workspaceName ? { workspaceName } : {}),
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    };
    await atomicWrite(this.filename, JSON.stringify(envelope));
  }

  async load(): Promise<StoredRailwayInfrastructureCredential | undefined> {
    try {
      const info = await lstat(this.filename);
      const uid = process.getuid?.();
      if (!info.isFile() || info.isSymbolicLink() || (uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0 || info.size > 16 * 1024) throw new Error("Invalid Railway credential store");
      const envelope = JSON.parse(await readFile(this.filename, "utf8")) as CredentialEnvelope;
      if (envelope.version !== 1 || !["account", "workspace"].includes(envelope.tokenType)) throw new Error("Invalid Railway credential store");
      const workspaceId = bounded(envelope.workspaceId, "Railway workspace id", 256);
      const workspaceName = envelope.workspaceName === undefined ? undefined : bounded(envelope.workspaceName, "Railway workspace name", 256);
      const key = await this.key();
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
      const token = bounded(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]).toString("utf8"), "Railway token");
      return { token, tokenType: envelope.tokenType, workspaceId, ...(workspaceName ? { workspaceName } : {}) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}
