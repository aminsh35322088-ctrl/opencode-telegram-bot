import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { config } from "../../config.js";
import { readAppState, updateAppState } from "../stores/app-state-store.js";
import { isRecord } from "../../utils/type-guards.js";

export type McpCredentialRecord =
  | {
      projectDirectory: string;
      serverName: string;
      remoteUrl: string;
      mode: "bearer";
      secret: string;
    }
  | {
      projectDirectory: string;
      serverName: string;
      remoteUrl: string;
      mode: "api-key";
      headerName: string;
      secret: string;
    }
  | {
      projectDirectory: string;
      serverName: string;
      remoteUrl: string;
      mode: "custom-header";
      headerName: string;
      secret: string;
    }
  | {
      projectDirectory: string;
      serverName: string;
      remoteUrl: string;
      mode: "oauth-client";
      clientId: string;
      clientSecret?: string;
      scope?: string;
    };

interface EncryptedCredential {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

interface McpCredentialState {
  version: 1;
  records: Record<string, EncryptedCredential>;
}

const STORE_KEY = "mcpCredentials";
const KEY_SALT = Buffer.from("opencode-telegram-bot:mcp-credentials:v1", "utf8");
const KEY_INFO = Buffer.from("mcp-credential-store", "utf8");

function normalizeDirectory(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/u, "");
}

function credentialId(projectDirectory: string, serverName: string): string {
  return createHash("sha256")
    .update(normalizeDirectory(projectDirectory))
    .update("\0")
    .update(serverName.trim())
    .digest("hex");
}

function encryptionKey(): Buffer {
  const token = config.telegram.token;
  if (!token) throw new Error("Cannot encrypt MCP credentials without the Telegram bot token.");
  return Buffer.from(hkdfSync("sha256", Buffer.from(token, "utf8"), KEY_SALT, KEY_INFO, 32));
}

function parseState(value: unknown): McpCredentialState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.records)) {
    return { version: 1, records: {} };
  }
  const records: Record<string, EncryptedCredential> = {};
  for (const [key, item] of Object.entries(value.records)) {
    if (
      !isRecord(item) ||
      item.version !== 1 ||
      typeof item.iv !== "string" ||
      typeof item.tag !== "string" ||
      typeof item.ciphertext !== "string"
    ) {
      continue;
    }
    records[key] = {
      version: 1,
      iv: item.iv,
      tag: item.tag,
      ciphertext: item.ciphertext,
    };
  }
  return { version: 1, records };
}

function assertHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MCP remote URL must be an absolute HTTP(S) URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("MCP remote URL must be an absolute HTTP(S) URL.");
  }
  return url.toString();
}

function normalizeRecord(record: McpCredentialRecord): McpCredentialRecord {
  const base = {
    projectDirectory: normalizeDirectory(record.projectDirectory),
    serverName: record.serverName.trim(),
    remoteUrl: assertHttpUrl(record.remoteUrl.trim()),
  };
  if (!base.projectDirectory) throw new Error("MCP project directory is required.");
  if (!base.serverName) throw new Error("MCP server name is required.");

  if (record.mode === "bearer") {
    const secret = record.secret.trim();
    if (!secret) throw new Error("MCP bearer token is required.");
    return { ...base, mode: "bearer", secret };
  }

  if (record.mode === "api-key" || record.mode === "custom-header") {
    const headerName = record.headerName.trim();
    const secret = record.secret.trim();
    if (!headerName) throw new Error("MCP authentication header name is required.");
    if (!secret) throw new Error("MCP authentication secret is required.");
    return { ...base, mode: record.mode, headerName, secret };
  }

  const clientId = record.clientId.trim();
  const clientSecret = record.clientSecret?.trim();
  const scope = record.scope?.trim();
  if (!clientId) throw new Error("MCP OAuth client ID is required.");
  return {
    ...base,
    mode: "oauth-client",
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    ...(scope ? { scope } : {}),
  };
}

function isCredentialRecord(value: unknown): value is McpCredentialRecord {
  if (!isRecord(value)) return false;
  if (
    typeof value.projectDirectory !== "string" ||
    typeof value.serverName !== "string" ||
    typeof value.remoteUrl !== "string" ||
    typeof value.mode !== "string"
  ) {
    return false;
  }
  if (value.mode === "bearer") return typeof value.secret === "string";
  if (value.mode === "api-key" || value.mode === "custom-header") {
    return typeof value.headerName === "string" && typeof value.secret === "string";
  }
  if (value.mode === "oauth-client") {
    return (
      typeof value.clientId === "string" &&
      (value.clientSecret === undefined || typeof value.clientSecret === "string") &&
      (value.scope === undefined || typeof value.scope === "string")
    );
  }
  return false;
}

function encryptRecord(record: McpCredentialRecord, id: string): EncryptedCredential {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(id, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(record), "utf8"),
    cipher.final(),
  ]);
  return {
    version: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptRecord(record: EncryptedCredential, id: string): McpCredentialRecord {
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      Buffer.from(record.iv, "base64"),
    );
    decipher.setAAD(Buffer.from(id, "utf8"));
    decipher.setAuthTag(Buffer.from(record.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const parsed: unknown = JSON.parse(plaintext);
    if (!isCredentialRecord(parsed)) throw new Error("Invalid MCP credential payload.");
    return normalizeRecord(parsed);
  } catch (error) {
    throw new Error("Unable to decrypt stored MCP credential.", { cause: error });
  }
}

export async function saveMcpCredential(record: McpCredentialRecord): Promise<void> {
  const normalized = normalizeRecord(record);
  const id = credentialId(normalized.projectDirectory, normalized.serverName);
  const encrypted = encryptRecord(normalized, id);
  await updateAppState((state) => {
    const current = parseState(state[STORE_KEY]);
    return {
      [STORE_KEY]: {
        version: 1,
        records: { ...current.records, [id]: encrypted },
      },
    };
  });
}

export async function loadMcpCredential(
  projectDirectory: string,
  serverName: string,
): Promise<McpCredentialRecord | null> {
  const state = await readAppState();
  const store = parseState(state[STORE_KEY]);
  const id = credentialId(projectDirectory, serverName);
  const encrypted = store.records[id];
  if (!encrypted) return null;
  return decryptRecord(encrypted, id);
}

export async function listMcpCredentials(): Promise<McpCredentialRecord[]> {
  const state = await readAppState();
  const store = parseState(state[STORE_KEY]);
  return Object.entries(store.records).map(([id, record]) => decryptRecord(record, id));
}

export async function removeMcpCredential(
  projectDirectory: string,
  serverName: string,
): Promise<boolean> {
  const id = credentialId(projectDirectory, serverName);
  let removed = false;
  await updateAppState((state) => {
    const current = parseState(state[STORE_KEY]);
    if (!current.records[id]) return { [STORE_KEY]: current };
    const next = { ...current.records };
    delete next[id];
    removed = true;
    return { [STORE_KEY]: { version: 1, records: next } };
  });
  return removed;
}
