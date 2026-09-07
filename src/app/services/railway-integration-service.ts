import { readAppState, updateAppState } from "../stores/app-state-store.js";

const RAILWAY_GRAPHQL_ENDPOINT = "https://backboard.railway.com/graphql/v2";
const TOKEN_VALIDATION_TIMEOUT_MS = 10000;
const ACCOUNT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface RailwayAccount { id: string; name: string; tokenFile: string; createdAt: string; tokenType: RailwayTokenType; }
export type RailwayTokenType = "account" | "workspace" | "project";
export interface RailwayTokenValidation { valid: boolean; tokenType?: RailwayTokenType; subjectName?: string; subjectEmail?: string; projectId?: string; environmentId?: string; reason?: "invalid" | "unauthorized" | "timeout" | "network" | "api_error"; }
interface StoredRailwayAccount extends RailwayAccount { token: string; }
interface RailwayIndex { activeId: string | undefined; accounts: StoredRailwayAccount[]; }

let storeQueue = Promise.resolve();
function withStoreLock<T>(operation: () => Promise<T>): Promise<T> { const previous = storeQueue; let release!: () => void; storeQueue = new Promise<void>((resolve) => { release = resolve; }); return previous.then(async () => { try { return await operation(); } finally { release(); } }); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function getIntegrationState(state: Awaited<ReturnType<typeof readAppState>>): Record<string, unknown> { return isRecord(state.integrations) ? state.integrations : {}; }
function normalizeIndex(value: unknown): RailwayIndex {
  if (!isRecord(value)) return { accounts: [], activeId: undefined };
  const raw = value as Partial<RailwayIndex>; const accounts: StoredRailwayAccount[] = []; const seen = new Set<string>();
  if (Array.isArray(raw.accounts)) for (const candidate of raw.accounts) {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || !ACCOUNT_ID_PATTERN.test(candidate.id) || typeof candidate.name !== "string" || typeof candidate.token !== "string" || typeof candidate.createdAt !== "string" || !["account", "workspace", "project"].includes(String(candidate.tokenType)) || seen.has(candidate.id)) continue;
    seen.add(candidate.id); accounts.push({ id: candidate.id, name: candidate.name.trim(), tokenFile: "", createdAt: candidate.createdAt, tokenType: candidate.tokenType as RailwayTokenType, token: candidate.token.trim() });
  }
  const activeId = typeof raw.activeId === "string" && seen.has(raw.activeId) ? raw.activeId : accounts[0]?.id; return { accounts, activeId };
}
async function readIndex(): Promise<RailwayIndex> { const state = await readAppState(); return normalizeIndex(getIntegrationState(state).railway); }
async function writeIndex(index: RailwayIndex): Promise<void> { const state = await readAppState(); await updateAppState({ integrations: { ...getIntegrationState(state), railway: index } }); }
function publicAccount(account: StoredRailwayAccount): RailwayAccount { const { token: _token, ...safe } = account; void _token; return safe; }
function normalizeToken(value: string): string { const token = value.trim(); if (!token) throw new Error("Railway token is empty"); if (token.length > 1024) throw new Error("Railway token is too long"); return token; }
function slugify(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "railway"; }
interface RailwayGraphqlPayload { data?: { me?: { name?: string | null; email?: string | null } | null; projectToken?: { projectId?: string | null; environmentId?: string | null } | null; projects?: { edges?: Array<{ node?: { id?: string | null; name?: string | null } | null }> } | null }; errors?: Array<{ message?: string; extensions?: { code?: string; traceId?: string } }>; }
async function railwayGraphql(token: string, query: string, headerName: "Authorization" | "Project-Access-Token"): Promise<{ response: Response; payload: RailwayGraphqlPayload }> { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), TOKEN_VALIDATION_TIMEOUT_MS); try { const response = await fetch(RAILWAY_GRAPHQL_ENDPOINT, { method: "POST", headers: { [headerName]: headerName === "Authorization" ? `Bearer ${token}` : token, "Content-Type": "application/json" }, body: JSON.stringify({ query }), signal: controller.signal }); let payload: RailwayGraphqlPayload = {}; try { payload = (await response.json()) as RailwayGraphqlPayload; } catch { payload = {}; } return { response, payload }; } finally { clearTimeout(timer); } }
export async function validateRailwayToken(tokenValue: string): Promise<RailwayTokenValidation> {
  const token = normalizeToken(tokenValue);
  try {
    const accountAttempt = await railwayGraphql(token, "query { me { name email } }", "Authorization"); const accountMe = accountAttempt.payload.data?.me;
    if (accountAttempt.response.ok && accountMe) return { valid: true, tokenType: "account", subjectName: accountMe.name ?? undefined, subjectEmail: accountMe.email ?? undefined };
    const projectAttempt = await railwayGraphql(token, "query { projectToken { projectId environmentId } }", "Project-Access-Token"); const projectToken = projectAttempt.payload.data?.projectToken;
    if (projectAttempt.response.ok && projectToken?.projectId && projectToken.environmentId) return { valid: true, tokenType: "project", projectId: projectToken.projectId, environmentId: projectToken.environmentId };
    const workspaceAttempt = await railwayGraphql(token, "query { projects { edges { node { id name } } } }", "Authorization"); const workspaceProjects = workspaceAttempt.payload.data?.projects?.edges;
    if (workspaceAttempt.response.ok && Array.isArray(workspaceProjects)) return { valid: true, tokenType: "workspace" };
    const attempts = [accountAttempt, projectAttempt, workspaceAttempt]; if (attempts.some(({ response }) => response.status === 401 || response.status === 403)) return { valid: false, reason: "unauthorized" }; const apiError = attempts.flatMap(({ payload }) => payload.errors ?? [])[0]; if (apiError?.message) return { valid: false, reason: "api_error" }; return { valid: false, reason: "invalid" };
  } catch (error) { if (error instanceof DOMException && error.name === "AbortError") return { valid: false, reason: "timeout" }; return { valid: false, reason: "network" }; }
}
async function applyActiveRailwayToken(): Promise<void> { const index = await readIndex(); const active = index.accounts.find((account) => account.id === index.activeId) ?? index.accounts[0]; delete process.env.RAILWAY_TOKEN; delete process.env.RAILWAY_API_TOKEN; if (active) { if (active.tokenType === "project") process.env.RAILWAY_TOKEN = active.token; else process.env.RAILWAY_API_TOKEN = active.token; } }
export async function listRailwayAccounts(): Promise<RailwayAccount[]> { return withStoreLock(async () => (await readIndex()).accounts.map(publicAccount)); }
export async function getActiveRailwayAccount(): Promise<RailwayAccount | null> { return withStoreLock(async () => { const index = await readIndex(); const account = index.accounts.find((item) => item.id === index.activeId) ?? index.accounts[0]; return account ? publicAccount(account) : null; }); }
export async function addRailwayAccount(name: string, tokenValue: string, tokenType: RailwayTokenType = "account"): Promise<RailwayAccount> { const token = normalizeToken(tokenValue); const cleanName = name.trim(); if (!cleanName) throw new Error("Railway account name is empty"); return withStoreLock(async () => { const index = await readIndex(); const base = slugify(cleanName); let id = base; let counter = 2; while (index.accounts.some((account) => account.id === id)) id = `${base}-${counter++}`; const account: StoredRailwayAccount = { id, name: cleanName, tokenFile: "", createdAt: new Date().toISOString(), tokenType, token }; index.accounts.push(account); if (!index.activeId) index.activeId = account.id; await writeIndex(index); await applyActiveRailwayToken(); return publicAccount(account); }); }
export async function removeRailwayAccount(id: string): Promise<boolean> { return withStoreLock(async () => { const index = await readIndex(); if (!index.accounts.some((item) => item.id === id)) return false; index.accounts = index.accounts.filter((item) => item.id !== id); if (index.activeId === id) index.activeId = index.accounts[0]?.id; await writeIndex(index); await applyActiveRailwayToken(); return true; }); }
export async function setActiveRailwayAccount(id: string): Promise<RailwayAccount> { return withStoreLock(async () => { const index = await readIndex(); const account = index.accounts.find((item) => item.id === id); if (!account) throw new Error("Railway account not found"); index.activeId = id; await writeIndex(index); await applyActiveRailwayToken(); return publicAccount(account); }); }
export async function getRailwayToken(): Promise<string> { return withStoreLock(async () => { const index = await readIndex(); const account = index.accounts.find((item) => item.id === index.activeId) ?? index.accounts[0]; return account?.token ?? ""; }); }
export async function getActiveRailwayTokenType(): Promise<RailwayTokenType | null> { return withStoreLock(async () => { const index = await readIndex(); return (index.accounts.find((item) => item.id === index.activeId) ?? index.accounts[0])?.tokenType ?? null; }); }
export async function hasRailwayToken(): Promise<boolean> { try { return Boolean(await getRailwayToken()); } catch { return false; } }
export async function clearRailwayToken(): Promise<void> { await withStoreLock(async () => { const state = await readAppState(); await updateAppState({ integrations: { ...getIntegrationState(state), railway: { accounts: [], activeId: undefined } } }); delete process.env.RAILWAY_TOKEN; delete process.env.RAILWAY_API_TOKEN; }); }

export async function initializeRailwayTokenFromEnvironment(): Promise<boolean> {
  // Railway credentials are owned by the bot's persistent Integrations store.
  // Railway environment variables are intentionally not a credential source.
  const index = await readIndex();
  delete process.env.RAILWAY_TOKEN;
  delete process.env.RAILWAY_API_TOKEN;
  if (!index.accounts.length) return false;
  await applyActiveRailwayToken();
  return true;
}