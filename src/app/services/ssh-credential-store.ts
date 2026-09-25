import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { config } from "../../config.js";
import { readAppState, updateAppState } from "../stores/app-state-store.js";
import { isRecord } from "../../utils/type-guards.js";

export type SshCredential =
  | { id: string; label: string; mode: "password"; password: string; createdAt: string; updatedAt: string }
  | { id: string; label: string; mode: "private-key"; privateKey: string; createdAt: string; updatedAt: string };

export interface SshCredentialSummary {
  id: string;
  label: string;
  mode: SshCredential["mode"];
  createdAt: string;
  updatedAt: string;
}

interface EncryptedCredential {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

interface SshCredentialState {
  version: 1;
  records: Record<string, EncryptedCredential>;
}

const STORE_KEY = "sshCredentials";
const KEY_SALT = Buffer.from("opencode-telegram-bot:ssh-credentials:v1", "utf8");
const KEY_INFO = Buffer.from("ssh-credential-store", "utf8");
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function normalizeId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!ID_PATTERN.test(id)) throw new Error("SSH credential id must be a lowercase slug.");
  return id;
}

function encryptionKey(): Buffer {
  const token = config.telegram.token;
  if (!token) throw new Error("Cannot encrypt SSH credentials without the Telegram bot token.");
  return Buffer.from(hkdfSync("sha256", Buffer.from(token, "utf8"), KEY_SALT, KEY_INFO, 32));
}

function parseState(value: unknown): SshCredentialState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.records)) return { version: 1, records: {} };
  const records: Record<string, EncryptedCredential> = {};
  for (const [id, item] of Object.entries(value.records)) {
    if (
      !ID_PATTERN.test(id) ||
      !isRecord(item) ||
      item.version !== 1 ||
      typeof item.iv !== "string" ||
      typeof item.tag !== "string" ||
      typeof item.ciphertext !== "string"
    ) continue;
    records[id] = { version: 1, iv: item.iv, tag: item.tag, ciphertext: item.ciphertext };
  }
  return { version: 1, records };
}

function validateCredential(record: SshCredential): SshCredential {
  const id = normalizeId(record.id);
  const label = record.label.trim() || id;
  if (record.mode === "password") {
    if (!record.password || record.password.includes("\0")) throw new Error("SSH password is empty or invalid.");
    if (record.password.length > 4096) throw new Error("SSH password is too long.");
    return { ...record, id, label };
  }
  const privateKey = record.privateKey.trim();
  if (!privateKey.includes("PRIVATE KEY-----")) throw new Error("SSH private key payload is invalid.");
  if (privateKey.length > 256 * 1024) throw new Error("SSH private key is too large.");
  return { ...record, id, label, privateKey: `${privateKey}\n` };
}

function isCredential(value: unknown): value is SshCredential {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== "string" ||
    typeof value.label !== "string" ||
    typeof value.mode !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) return false;
  if (value.mode === "password") return typeof value.password === "string";
  if (value.mode === "private-key") return typeof value.privateKey === "string";
  return false;
}

function encrypt(record: SshCredential): EncryptedCredential {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(record.id, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(record), "utf8"), cipher.final()]);
  return {
    version: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decrypt(record: EncryptedCredential, id: string): SshCredential {
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(record.iv, "base64"));
    decipher.setAAD(Buffer.from(id, "utf8"));
    decipher.setAuthTag(Buffer.from(record.tag, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]).toString("utf8");
    const parsed: unknown = JSON.parse(plaintext);
    if (!isCredential(parsed)) throw new Error("Invalid SSH credential payload.");
    return validateCredential(parsed);
  } catch (error) {
    throw new Error("Unable to decrypt stored SSH credential.", { cause: error });
  }
}

function summary(record: SshCredential): SshCredentialSummary {
  return { id: record.id, label: record.label, mode: record.mode, createdAt: record.createdAt, updatedAt: record.updatedAt };
}

async function save(record: Omit<SshCredential, "createdAt" | "updatedAt">): Promise<SshCredentialSummary> {
  const id = normalizeId(record.id);
  let saved!: SshCredential;
  await updateAppState((state) => {
    const current = parseState(state[STORE_KEY]);
    const existing = current.records[id] ? decrypt(current.records[id]!, id) : null;
    const now = new Date().toISOString();
    saved = validateCredential({ ...record, id, createdAt: existing?.createdAt ?? now, updatedAt: now } as SshCredential);
    return { [STORE_KEY]: { version: 1, records: { ...current.records, [id]: encrypt(saved) } } };
  });
  return summary(saved);
}

export async function saveSshPasswordCredential(id: string, label: string, password: string): Promise<SshCredentialSummary> {
  return save({ id, label, mode: "password", password });
}

export async function saveSshPrivateKeyCredential(id: string, label: string, privateKey: string): Promise<SshCredentialSummary> {
  return save({ id, label, mode: "private-key", privateKey });
}

export async function loadSshCredential(id: string): Promise<SshCredential | null> {
  const key = normalizeId(id);
  const state = await readAppState();
  const encrypted = parseState(state[STORE_KEY]).records[key];
  return encrypted ? decrypt(encrypted, key) : null;
}

export async function listSshCredentialSummaries(): Promise<SshCredentialSummary[]> {
  const state = await readAppState();
  const store = parseState(state[STORE_KEY]);
  return Object.entries(store.records).map(([id, item]) => summary(decrypt(item, id))).sort((a, b) => a.label.localeCompare(b.label));
}

export async function removeSshCredential(id: string): Promise<boolean> {
  const key = normalizeId(id);
  let removed = false;
  await updateAppState((state) => {
    const current = parseState(state[STORE_KEY]);
    if (!current.records[key]) return { [STORE_KEY]: current };
    const records = { ...current.records };
    delete records[key];
    removed = true;
    return { [STORE_KEY]: { version: 1, records } };
  });
  return removed;
}

export function sshCredentialFingerprint(id: string): string {
  return createHash("sha256").update(normalizeId(id)).digest("hex").slice(0, 16);
}
