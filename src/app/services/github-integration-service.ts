import { readAppState, updateAppState } from "../stores/app-state-store.js";
import {
  removeExtensionCredentials,
  resolveExtensionCredential,
  saveExtensionCredential,
} from "./credential-vault-service.js";

const GITHUB_API_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const TOKEN_CREDENTIAL_ID = "token";

export interface GithubAccount {
  id: string;
  name: string;
  username: string | undefined;
  tokenFile: string;
  createdAt: string;
}
interface StoredGithubAccount extends GithubAccount {
  credentialId: string;
  /** Legacy plaintext token. Migrated into Credential Vault on read. */
  token?: string;
}
interface GithubIndex { activeId: string | undefined; accounts: StoredGithubAccount[]; }
export interface GithubTokenValidation { valid: boolean; username?: string; reason?: "missing" | "unauthorized" | "forbidden" | "network" | "invalid_response"; }

let storeQueue = Promise.resolve();
function withStoreLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = storeQueue;
  let release!: () => void;
  storeQueue = new Promise<void>((resolve) => { release = resolve; });
  return previous.then(async () => {
    try { return await operation(); }
    finally { release(); }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function getIntegrationState(state: Awaited<ReturnType<typeof readAppState>>): Record<string, unknown> {
  return isRecord(state.integrations) ? state.integrations : {};
}
function githubExtensionId(id: string): string {
  return `integration:github:${id}`;
}
function normalizeIndex(value: unknown): GithubIndex {
  if (!isRecord(value)) return { accounts: [], activeId: undefined };
  const raw = value as Partial<GithubIndex>;
  const accounts: StoredGithubAccount[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw.accounts)) {
    for (const candidate of raw.accounts) {
      if (
        !isRecord(candidate)
        || typeof candidate.id !== "string"
        || typeof candidate.name !== "string"
        || typeof candidate.createdAt !== "string"
        || seen.has(candidate.id)
      ) continue;
      const token = typeof candidate.token === "string" ? candidate.token.trim() : undefined;
      const credentialId =
        typeof candidate.credentialId === "string" && candidate.credentialId.trim()
          ? candidate.credentialId.trim()
          : TOKEN_CREDENTIAL_ID;
      seen.add(candidate.id);
      accounts.push({
        id: candidate.id,
        name: candidate.name.trim(),
        username: typeof candidate.username === "string" ? candidate.username.trim() || undefined : undefined,
        tokenFile: "",
        createdAt: candidate.createdAt,
        credentialId,
        ...(token ? { token } : {}),
      });
    }
  }
  const activeId = typeof raw.activeId === "string" && seen.has(raw.activeId)
    ? raw.activeId
    : accounts[0]?.id;
  return { accounts, activeId };
}
async function readIndex(): Promise<GithubIndex> {
  const state = await readAppState();
  const index = normalizeIndex(getIntegrationState(state).github);
  let migrated = false;
  for (const account of index.accounts) {
    const legacy = account.token?.trim();
    if (!legacy) continue;
    await saveExtensionCredential(githubExtensionId(account.id), account.credentialId, legacy);
    delete account.token;
    migrated = true;
  }
  if (migrated) await writeIndex(index);
  return index;
}
async function writeIndex(index: GithubIndex): Promise<void> {
  const state = await readAppState();
  const accounts = index.accounts.map(({ token: _legacy, ...account }) => {
    void _legacy;
    return account;
  });
  await updateAppState({
    integrations: {
      ...getIntegrationState(state),
      github: { activeId: index.activeId, accounts },
    },
  });
}
function publicAccount(account: StoredGithubAccount): GithubAccount {
  const { credentialId: _credentialId, token: _token, ...safe } = account;
  void _credentialId;
  void _token;
  return safe;
}
function normalizeToken(value: string): string {
  const token = value.trim();
  if (!token) throw new Error("GitHub token is empty");
  if (token.length > 1024) throw new Error("GitHub token is too long");
  return token;
}
function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "github";
}
function getActiveAccount(index: GithubIndex): StoredGithubAccount | undefined {
  return index.accounts.find((account) => account.id === index.activeId) ?? index.accounts[0];
}
async function accountToken(account: StoredGithubAccount | undefined): Promise<string> {
  if (!account) return "";
  return (await resolveExtensionCredential(githubExtensionId(account.id), account.credentialId))?.trim() ?? "";
}
async function applyActiveToken(index: GithubIndex): Promise<string> {
  const active = getActiveAccount(index);
  const token = await accountToken(active);
  if (!active || !token) {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    return "";
  }
  process.env.GITHUB_TOKEN = token;
  process.env.GH_TOKEN = token;
  return token;
}

export async function validateGithubToken(tokenValue: string): Promise<GithubTokenValidation> {
  const token = tokenValue.trim();
  if (!token) return { valid: false, reason: "missing" };
  try {
    const response = await fetch(`${GITHUB_API_URL}/user`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401) return { valid: false, reason: "unauthorized" };
    if (response.status === 403) return { valid: false, reason: "forbidden" };
    if (!response.ok) return { valid: false, reason: "invalid_response" };
    const payload = (await response.json()) as { login?: unknown };
    if (typeof payload.login !== "string" || !payload.login.trim()) {
      return { valid: false, reason: "invalid_response" };
    }
    return { valid: true, username: payload.login };
  } catch {
    return { valid: false, reason: "network" };
  }
}
export async function listGithubAccounts(): Promise<GithubAccount[]> {
  return (await readIndex()).accounts.map(publicAccount);
}
export async function getActiveGithubAccount(): Promise<GithubAccount | null> {
  const index = await readIndex();
  const account = getActiveAccount(index);
  return account ? publicAccount(account) : null;
}
export async function addGithubAccount(name: string, tokenValue: string, username?: string): Promise<GithubAccount> {
  const token = normalizeToken(tokenValue);
  const cleanName = name.trim();
  if (!cleanName) throw new Error("GitHub account name is empty");
  const validation = await validateGithubToken(token);
  if (!validation.valid) {
    const reason =
      validation.reason === "unauthorized" ? "GitHub rejected this token (unauthorized)."
        : validation.reason === "forbidden" ? "GitHub rejected this token (forbidden)."
          : validation.reason === "network" ? "Could not reach the GitHub API to verify this token."
            : "GitHub returned an invalid token response.";
    throw new Error(`${reason} The token was not saved.`);
  }
  return withStoreLock(async () => {
    const index = await readIndex();
    const base = slugify(cleanName);
    let id = base;
    let counter = 2;
    while (index.accounts.some((account) => account.id === id)) id = `${base}-${counter++}`;
    const account: StoredGithubAccount = {
      id,
      name: cleanName,
      username: validation.username ?? username?.trim() ?? undefined,
      tokenFile: "",
      createdAt: new Date().toISOString(),
      credentialId: TOKEN_CREDENTIAL_ID,
    };
    await saveExtensionCredential(githubExtensionId(id), TOKEN_CREDENTIAL_ID, token);
    try {
      index.accounts.push(account);
      if (!index.activeId) index.activeId = account.id;
      await writeIndex(index);
    } catch (error) {
      await removeExtensionCredentials(githubExtensionId(id)).catch(() => 0);
      throw error;
    }
    await applyActiveToken(index);
    return publicAccount(account);
  });
}
export async function removeGithubAccount(id: string): Promise<boolean> {
  return withStoreLock(async () => {
    const index = await readIndex();
    if (!index.accounts.some((item) => item.id === id)) return false;
    index.accounts = index.accounts.filter((item) => item.id !== id);
    if (index.activeId === id) index.activeId = index.accounts[0]?.id;
    await writeIndex(index);
    await removeExtensionCredentials(githubExtensionId(id));
    await applyActiveToken(index);
    return true;
  });
}
export async function setActiveGithubAccount(id: string): Promise<GithubAccount> {
  return withStoreLock(async () => {
    const index = await readIndex();
    const account = index.accounts.find((item) => item.id === id);
    if (!account) throw new Error("GitHub account not found");
    if (!await accountToken(account)) throw new Error("GitHub account credential is missing");
    index.activeId = id;
    await writeIndex(index);
    await applyActiveToken(index);
    return publicAccount(account);
  });
}

export async function initializeGithubIntegration(): Promise<boolean> {
  const index = await readIndex();
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  if (!index.accounts.length) return false;
  return Boolean(await applyActiveToken(index));
}
