import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { config } from "../../config.js";
import { readAppState, updateAppState } from "../stores/app-state-store.js";
import { isRecord } from "../../utils/type-guards.js";

export type CredentialStatus = "missing" | "configured";

interface EncryptedSecret {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

interface CredentialMetadata {
  extensionId: string;
  credentialId: string;
  createdAt: string;
  updatedAt: string;
}

interface VaultEntry {
  metadata: CredentialMetadata;
  secret: EncryptedSecret;
}

interface VaultState {
  version: 1;
  entries: Record<string, VaultEntry>;
}

const STORE_KEY = "credentialVault";
const KEY_SALT = Buffer.from("opencode-telegram-bot:credential-vault:v1", "utf8");
const KEY_INFO = Buffer.from("extension-credential-vault", "utf8");

function vaultKey(): Buffer {
  const token = config.telegram.token;
  if (!token) throw new Error("Credential vault is unavailable without the Telegram bot token.");
  return Buffer.from(hkdfSync("sha256", Buffer.from(token, "utf8"), KEY_SALT, KEY_INFO, 32));
}

function entryKey(extensionId: string, credentialId: string): string {
  return createHash("sha256").update(extensionId.trim()).update("\0").update(credentialId.trim()).digest("hex");
}

function parseState(value: unknown): VaultState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.entries)) return { version: 1, entries: {} };
  const entries: Record<string, VaultEntry> = {};
  for (const [id, candidate] of Object.entries(value.entries)) {
    if (!isRecord(candidate) || !isRecord(candidate.metadata) || !isRecord(candidate.secret)) continue;
    const metadata = candidate.metadata;
    const secret = candidate.secret;
    if (
      typeof metadata.extensionId !== "string" ||
      typeof metadata.credentialId !== "string" ||
      typeof metadata.createdAt !== "string" ||
      typeof metadata.updatedAt !== "string" ||
      secret.version !== 1 ||
      typeof secret.iv !== "string" ||
      typeof secret.tag !== "string" ||
      typeof secret.ciphertext !== "string"
    ) continue;
    entries[id] = {
      metadata: {
        extensionId: metadata.extensionId,
        credentialId: metadata.credentialId,
        createdAt: metadata.createdAt,
        updatedAt: metadata.updatedAt,
      },
      secret: { version: 1, iv: secret.iv, tag: secret.tag, ciphertext: secret.ciphertext },
    };
  }
  return { version: 1, entries };
}

function encrypt(secret: string, aad: string): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", vaultKey(), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return { version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}

function decrypt(secret: EncryptedSecret, aad: string): string {
  try {
    const decipher = createDecipheriv("aes-256-gcm", vaultKey(), Buffer.from(secret.iv, "base64"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(secret.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(secret.ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch (error) {
    throw new Error("Unable to decrypt extension credential.", { cause: error });
  }
}

function normalizeSecret(value: string): string {
  const secret = value.trim();
  if (!secret || secret.length > 16384 || /[\0\r\n]/u.test(secret)) throw new Error("Credential value is invalid.");
  return secret;
}

export async function saveExtensionCredential(extensionId: string, credentialId: string, value: string): Promise<void> {
  const secret = normalizeSecret(value);
  const id = entryKey(extensionId, credentialId);
  const now = new Date().toISOString();
  const encrypted = encrypt(secret, id);
  await updateAppState((state) => {
    const current = parseState(state[STORE_KEY]);
    const previous = current.entries[id];
    const entry: VaultEntry = {
      metadata: { extensionId, credentialId, createdAt: previous?.metadata.createdAt ?? now, updatedAt: now },
      secret: encrypted,
    };
    return { [STORE_KEY]: { version: 1, entries: { ...current.entries, [id]: entry } } };
  });
}

export async function resolveExtensionCredential(extensionId: string, credentialId: string): Promise<string | null> {
  const state = await readAppState();
  const id = entryKey(extensionId, credentialId);
  const entry = parseState(state[STORE_KEY]).entries[id];
  return entry ? decrypt(entry.secret, id) : null;
}

export async function getExtensionCredentialStatus(extensionId: string, credentialId: string): Promise<CredentialStatus> {
  const state = await readAppState();
  return parseState(state[STORE_KEY]).entries[entryKey(extensionId, credentialId)] ? "configured" : "missing";
}

export async function removeExtensionCredential(extensionId: string, credentialId: string): Promise<boolean> {
  const id = entryKey(extensionId, credentialId);
  let removed = false;
  await updateAppState((state) => {
    const current = parseState(state[STORE_KEY]);
    if (!current.entries[id]) return { [STORE_KEY]: current };
    const entries = { ...current.entries };
    delete entries[id];
    removed = true;
    return { [STORE_KEY]: { version: 1, entries } };
  });
  return removed;
}

export async function removeExtensionCredentials(extensionId: string): Promise<number> {
  let removed = 0;
  await updateAppState((state) => {
    const current = parseState(state[STORE_KEY]);
    const entries = Object.fromEntries(Object.entries(current.entries).filter(([, entry]) => {
      if (entry.metadata.extensionId !== extensionId) return true;
      removed += 1;
      return false;
    }));
    return { [STORE_KEY]: { version: 1, entries } };
  });
  return removed;
}
