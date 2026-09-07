import { getAppStatePath, readAppState, updateAppState } from "../stores/app-state-store.js";

const GITHUB_API_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

export interface GithubAccount {
  id: string;
  name: string;
  username: string | undefined;
  tokenFile: string;
  createdAt: string;
}
interface StoredGithubAccount extends GithubAccount { token: string; }
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
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function getIntegrationState(state: Awaited<ReturnType<typeof readAppState>>): Record<string, unknown> { return isRecord(state.integrations) ? state.integrations : {}; }
function normalizeIndex(value: unknown): GithubIndex {
  if (!isRecord(value)) return { accounts: [], activeId: undefined };
  const raw = value as Partial<GithubIndex>;
  const accounts: StoredGithubAccount[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw.accounts)) for (const candidate of raw.accounts) {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || typeof candidate.name !== "string" || typeof candidate.token !== "string" || typeof candidate.createdAt !== "string" || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    accounts.push({ id: candidate.id, name: candidate.name.trim(), username: typeof candidate.username === "string" ? candidate.username.trim() || undefined : undefined, tokenFile: "", createdAt: candidate.createdAt, token: candidate.token.trim() });
  }
  const activeId = typeof raw.activeId === "string" && seen.has(raw.activeId) ? raw.activeId : accounts[0]?.id;
  return { accounts, activeId };
}
async function readIndex(): Promise<GithubIndex> { const state = await readAppState(); return normalizeIndex(getIntegrationState(state).github); }
async function writeIndex(index: GithubIndex): Promise<void> { const state = await readAppState(); await updateAppState({ integrations: { ...getIntegrationState(state), github: index } }); }
function publicAccount(account: StoredGithubAccount): GithubAccount { const { token: _token, ...safe } = account; void _token; return safe; }
function normalizeToken(value: string): string { const token = value.trim(); if (!token) throw new Error("GitHub token is empty"); if (token.length > 1024) throw new Error("GitHub token is too long"); return token; }
function slugify(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "github"; }
function getActiveAccount(index: GithubIndex): StoredGithubAccount | undefined { return index.accounts.find((account) => account.id === index.activeId) ?? index.accounts[0]; }

function applyActiveToken(index: GithubIndex): string {
  const active = getActiveAccount(index);
  if (!active) {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    return "";
  }
  process.env.GITHUB_TOKEN = active.token;
  process.env.GH_TOKEN = active.token;
  return active.token;
}

export async function validateGithubToken(tokenValue: string): Promise<GithubTokenValidation> {
  const token = tokenValue.trim(); if (!token) return { valid: false, reason: "missing" };
  try {
    const response = await fetch(`${GITHUB_API_URL}/user`, { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": GITHUB_API_VERSION }, signal: AbortSignal.timeout(10_000) });
    if (response.status === 401) return { valid: false, reason: "unauthorized" }; if (response.status === 403) return { valid: false, reason: "forbidden" }; if (!response.ok) return { valid: false, reason: "invalid_response" };
    const payload = (await response.json()) as { login?: unknown }; if (typeof payload.login !== "string" || !payload.login.trim()) return { valid: false, reason: "invalid_response" }; return { valid: true, username: payload.login };
  } catch { return { valid: false, reason: "network" }; }
}
export async function listGithubAccounts(): Promise<GithubAccount[]> { return (await readIndex()).accounts.map(publicAccount); }
export async function getActiveGithubAccount(): Promise<GithubAccount | null> { const index = await readIndex(); const account = getActiveAccount(index); return account ? publicAccount(account) : null; }
export async function addGithubAccount(name: string, tokenValue: string, username?: string): Promise<GithubAccount> {
  const token = normalizeToken(tokenValue); const cleanName = name.trim(); if (!cleanName) throw new Error("GitHub account name is empty");
  const validation = await validateGithubToken(token); if (!validation.valid) { const reason = validation.reason === "unauthorized" ? "GitHub rejected this token (unauthorized)." : validation.reason === "forbidden" ? "GitHub rejected this token (forbidden)." : validation.reason === "network" ? "Could not reach the GitHub API to verify this token." : "GitHub returned an invalid token response."; throw new Error(`${reason} The token was not saved.`); }
  return withStoreLock(async () => {
    const index = await readIndex(); const base = slugify(cleanName); let id = base; let counter = 2; while (index.accounts.some((account) => account.id === id)) id = `${base}-${counter++}`;
    const account: StoredGithubAccount = { id, name: cleanName, username: validation.username ?? username?.trim() ?? undefined, tokenFile: "", createdAt: new Date().toISOString(), token };
    index.accounts.push(account); if (!index.activeId) index.activeId = account.id; await writeIndex(index); applyActiveToken(index); return publicAccount(account);
  });
}
export async function removeGithubAccount(id: string): Promise<boolean> { return withStoreLock(async () => { const index = await readIndex(); if (!index.accounts.some((item) => item.id === id)) return false; index.accounts = index.accounts.filter((item) => item.id !== id); if (index.activeId === id) index.activeId = index.accounts[0]?.id; await writeIndex(index); applyActiveToken(index); return true; }); }
export async function setActiveGithubAccount(id: string): Promise<GithubAccount> { return withStoreLock(async () => { const index = await readIndex(); const account = index.accounts.find((item) => item.id === id); if (!account) throw new Error("GitHub account not found"); index.activeId = id; await writeIndex(index); applyActiveToken(index); return publicAccount(account); }); }
export async function getGithubToken(): Promise<string> { return applyActiveToken(await readIndex()); }
export async function hasGithubToken(): Promise<boolean> { return Boolean(await getGithubToken()); }
export async function saveGithubToken(value: string): Promise<void> {
  const token = normalizeToken(value); const validation = await validateGithubToken(token); if (!validation.valid) throw new Error("GitHub token verification failed. The token was not saved.");
  await withStoreLock(async () => {
    const index = await readIndex(); const active = getActiveAccount(index);
    if (active) { active.token = token; active.username = validation.username ?? active.username; await writeIndex(index); applyActiveToken(index); return; }
    const account: StoredGithubAccount = { id: "github", name: "GitHub", username: validation.username, tokenFile: "", createdAt: new Date().toISOString(), token };
    index.accounts.push(account); index.activeId = account.id; await writeIndex(index); applyActiveToken(index);
  });
}
export async function clearGithubToken(): Promise<void> { await withStoreLock(async () => { const state = await readAppState(); await updateAppState({ integrations: { ...getIntegrationState(state), github: { accounts: [], activeId: undefined } } }); delete process.env.GITHUB_TOKEN; delete process.env.GH_TOKEN; }); }

export async function initializeGithubIntegration(): Promise<boolean> {
  // GitHub credentials are owned by the bot's persistent Integrations store.
  // Railway environment variables are intentionally not a credential source.
  const index = await readIndex();
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  if (!index.accounts.length) return false;
  applyActiveToken(index);
  return Boolean(getActiveAccount(index));
}

export function getGithubTokenPath(): string { return getAppStatePath(); }