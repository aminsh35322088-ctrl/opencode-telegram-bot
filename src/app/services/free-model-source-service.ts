import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { getRuntimePaths } from "../../runtime/paths.js";
import { logger } from "../../utils/logger.js";
import { readAppState, updateAppState } from "../stores/app-state-store.js";
import { getFreeModelSourcesEnabled, setFreeModelSourcesEnabled } from "../stores/settings-store.js";

export type FreeModelSourceID = "gemini" | "qwen" | "glm" | "ds" | "freebuff";

export interface FreeModelSourceConnection {
  id: FreeModelSourceID;
  label: string;
  configured: boolean;
  guestCapable: boolean;
  credentialLabel: string;
  note: string;
}

export interface BuiltInFreeProviderConfig {
  id: string;
  config: Record<string, unknown>;
}

interface StoredFreeModelSourceCredentials {
  geminiCookies?: string;
  qwenToken?: string;
  glmToken?: string;
  deepseekToken?: string;
  freebuffToken?: string;
}

interface SourceDefinition {
  id: FreeModelSourceID;
  providerID: string;
  providerLabel: string;
  routerPrefix: string;
  bridgePath: string;
  credentialKey: keyof StoredFreeModelSourceCredentials;
  credentialLabel: string;
  guestCapable: boolean;
  vision: boolean;
  fallbackModels: readonly string[];
  note: string;
}

const SOURCES: readonly SourceDefinition[] = [
  {
    id: "gemini",
    providerID: "experimental-gemini-web",
    providerLabel: "Gemini Web",
    routerPrefix: "gemini",
    bridgePath: "gemini",
    credentialKey: "geminiCookies",
    credentialLabel: "Google Gemini cookies",
    guestCapable: true,
    vision: true,
    fallbackModels: ["gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro"],
    note: "Guest works without cookies; account cookies are optional for broader quota/catalog access.",
  },
  {
    id: "qwen",
    providerID: "experimental-qwen-web",
    providerLabel: "Qwen Web",
    routerPrefix: "qwen",
    bridgePath: "qwen",
    credentialKey: "qwenToken",
    credentialLabel: "Qwen token cookie",
    guestCapable: true,
    vision: false,
    fallbackModels: ["qwen3.8-max", "qwen3.7-plus"],
    note: "Guest works on some networks; datacenter IPs can still hit Qwen/Baxia risk control.",
  },
  {
    id: "glm",
    providerID: "experimental-glm-web",
    providerLabel: "GLM Web",
    routerPrefix: "glm",
    bridgePath: "glm",
    credentialKey: "glmToken",
    credentialLabel: "Z.AI token",
    guestCapable: false,
    vision: true,
    fallbackModels: ["glm-5.3", "glm-5.3-flash"],
    note: "Chat needs a Z.AI account/device token; the source stays selectable but reports upstream auth guidance until connected.",
  },
  {
    id: "ds",
    providerID: "experimental-deepseek-web",
    providerLabel: "DeepSeek Web",
    routerPrefix: "ds",
    bridgePath: "ds",
    credentialKey: "deepseekToken",
    credentialLabel: "DeepSeek userToken",
    guestCapable: false,
    vision: false,
    fallbackModels: ["deepseek-chat", "deepseek-reasoner"],
    note: "DeepSeek web has no guest mode; connect one account token before using it.",
  },
  {
    id: "freebuff",
    providerID: "experimental-freebuff",
    providerLabel: "Freebuff",
    routerPrefix: "freebuff",
    bridgePath: "freebuff",
    credentialKey: "freebuffToken",
    credentialLabel: "Freebuff auth token",
    guestCapable: false,
    vision: false,
    fallbackModels: [
      "z-ai/glm-5.3-flash",
      "deepseek/deepseek-v4.1-flash",
      "mimo/mimo-v2.5",
      "upstage/solar-mini4",
    ],
    note: "Uses one normal Freebuff account token and respects Freebuff's own seat/quota/geography controls.",
  },
] as const;

const OMNI_HOST = "127.0.0.1";
const OMNI_PORT = 8790;
const OMNI_BASE_URL = `http://${OMNI_HOST}:${OMNI_PORT}`;
const OMNI_BINARY = "/usr/local/bin/omnirouter";
const ROUTER_KEY_ENV = "OPENCODE_TELEGRAM_OMNI_ROUTER_KEY";
const INTERNAL_TOKEN_ENV = "OPENCODE_TELEGRAM_OMNI_INTERNAL_TOKEN";
const ADMIN_PASSWORD_ENV = "OPENCODE_TELEGRAM_OMNI_ADMIN_PASSWORD";
const STARTUP_TIMEOUT_MS = 15_000;
const HEALTH_ATTEMPT_TIMEOUT_MS = 1_000;
const HEALTH_POLL_MS = 250;
const MODEL_DISCOVERY_TIMEOUT_MS = 5_000;
const EXPECTED_OMNI_VERSION = "1.4.0";
const PROCESS_EXIT_GRACE_MS = 2_500;
const PROCESS_KILL_GRACE_MS = 1_500;

let omniProcess: ChildProcess | null = null;
let omniReady = false;
let lifecycleTail: Promise<void> = Promise.resolve();
let discoveredModels: Partial<Record<FreeModelSourceID, string[]>> = {};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const result = lifecycleTail.then(operation, operation);
  lifecycleTail = result.then(() => undefined, () => undefined);
  return result;
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childHasExited(child)) return true;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(childHasExited(child)), timeoutMs);
    child.once("exit", onExit);
  });
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (childHasExited(child)) return;
  child.kill("SIGTERM");
  if (await waitForChildExit(child, PROCESS_EXIT_GRACE_MS)) return;
  child.kill("SIGKILL");
  if (!await waitForChildExit(child, PROCESS_KILL_GRACE_MS)) {
    logger.warn("[FreeModelSources] OmniRouter did not report exit after SIGKILL");
  }
}

function ensureSecret(envKey: string, prefix = ""): string {
  const existing = process.env[envKey]?.trim();
  if (existing) return existing;
  const value = prefix + randomBytes(24).toString("hex");
  process.env[envKey] = value;
  return value;
}

function executablePath(): string {
  return process.env.OMNIROUTER_BINARY?.trim() || OMNI_BINARY;
}

function normalizeCredentials(value: unknown): StoredFreeModelSourceCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const out: StoredFreeModelSourceCredentials = {};
  for (const key of ["geminiCookies", "qwenToken", "glmToken", "deepseekToken", "freebuffToken"] as const) {
    const candidate = raw[key];
    if (typeof candidate === "string" && candidate.trim()) out[key] = candidate.trim();
  }
  return out;
}

async function readCredentials(): Promise<StoredFreeModelSourceCredentials> {
  const state = await readAppState();
  return normalizeCredentials(state.freeModelSources);
}

export async function setFreeModelSourceCredential(sourceID: FreeModelSourceID, value: string): Promise<void> {
  const source = SOURCES.find((item) => item.id === sourceID);
  if (!source) throw new Error("Unknown free model source");
  const credential = value.trim();
  if (!credential) throw new Error("Credential is empty");
  await updateAppState((state) => {
    const current = normalizeCredentials(state.freeModelSources);
    return { freeModelSources: { ...current, [source.credentialKey]: credential } };
  });
}

export async function clearFreeModelSourceCredential(sourceID: FreeModelSourceID): Promise<boolean> {
  const source = SOURCES.find((item) => item.id === sourceID);
  if (!source) return false;
  let removed = false;
  await updateAppState((state) => {
    const current = normalizeCredentials(state.freeModelSources);
    if (!current[source.credentialKey]) return {};
    removed = true;
    delete current[source.credentialKey];
    return { freeModelSources: current };
  });
  return removed;
}

export async function listFreeModelSourceConnections(): Promise<FreeModelSourceConnection[]> {
  const credentials = await readCredentials();
  return SOURCES.map((source) => ({
    id: source.id,
    label: source.providerLabel,
    configured: Boolean(credentials[source.credentialKey]),
    guestCapable: source.guestCapable,
    credentialLabel: source.credentialLabel,
    note: source.note,
  }));
}

function parseModelIDs(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return [...new Set(
    data
      .map((item) => item && typeof item === "object" && !Array.isArray(item) ? (item as { id?: unknown }).id : undefined)
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map((id) => id.trim()),
  )].slice(0, 80);
}

async function discoverModelsFor(source: SourceDefinition, internalToken: string): Promise<string[]> {
  try {
    const response = await fetch(`${OMNI_BASE_URL}/${source.bridgePath}/v1/models`, {
      headers: { Authorization: `Bearer ${internalToken}` },
      signal: AbortSignal.timeout(MODEL_DISCOVERY_TIMEOUT_MS),
    });
    if (!response.ok) return [...source.fallbackModels];
    const ids = parseModelIDs(await response.json().catch(() => null));
    return ids.length ? ids : [...source.fallbackModels];
  } catch {
    return [...source.fallbackModels];
  }
}

async function discoverAllModels(internalToken: string): Promise<void> {
  const pairs = await Promise.all(SOURCES.map(async (source) => [source.id, await discoverModelsFor(source, internalToken)] as const));
  discoveredModels = Object.fromEntries(pairs) as Partial<Record<FreeModelSourceID, string[]>>;
}

function modelConfig(source: SourceDefinition, upstreamModelID: string): Record<string, unknown> {
  return {
    name: upstreamModelID,
    attachment: source.vision,
    tool_call: true,
    modalities: {
      input: source.vision ? ["text", "image"] : ["text"],
      output: ["text"],
    },
  };
}

export function buildFreeSourceProviderConfigs(
  catalogs: Partial<Record<FreeModelSourceID, readonly string[]>>,
  configured: ReadonlySet<FreeModelSourceID> = new Set(),
): BuiltInFreeProviderConfig[] {
  return SOURCES.map((source) => {
    const raw = catalogs[source.id] ?? source.fallbackModels;
    const models = [...new Set(raw.map((id) => id.trim()).filter(Boolean))];
    const effective = models.length ? models : [...source.fallbackModels];
    const connection = configured.has(source.id)
      ? "Account connected"
      : source.guestCapable
        ? "Guest"
        : "Connect required";
    return {
      id: source.providerID,
      config: {
        npm: "@ai-sdk/openai-compatible",
        name: `${source.providerLabel} · Experimental · ${connection}`,
        options: {
          baseURL: `${OMNI_BASE_URL}/v1`,
          apiKey: `{env:${ROUTER_KEY_ENV}}`,
        },
        models: Object.fromEntries(effective.map((upstreamModelID) => [
          `${source.routerPrefix}/${upstreamModelID}`,
          modelConfig(source, upstreamModelID),
        ])),
      },
    };
  });
}

export async function getBuiltInFreeProviderConfigs(): Promise<BuiltInFreeProviderConfig[]> {
  if (!getFreeModelSourcesEnabled() || !omniReady) return [];
  const credentials = await readCredentials();
  const configured = new Set<FreeModelSourceID>();
  for (const source of SOURCES) {
    if (credentials[source.credentialKey]) configured.add(source.id);
  }
  return buildFreeSourceProviderConfigs(discoveredModels, configured);
}

export function isFreeModelSourceRuntimeReady(): boolean {
  return omniReady;
}

async function waitForOmni(processRef: ChildProcess, getSpawnError: () => Error | null): Promise<boolean> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const spawnError = getSpawnError();
    if (spawnError) throw spawnError;
    if (childHasExited(processRef)) return false;
    try {
      const response = await fetch(`${OMNI_BASE_URL}/health`, {
        signal: AbortSignal.timeout(HEALTH_ATTEMPT_TIMEOUT_MS),
      });
      if (response.ok) {
        const body = await response.json().catch(() => null) as { service?: unknown; version?: unknown } | null;
        if (body?.service === "omnirouter" && body.version === EXPECTED_OMNI_VERSION) {
          // A stale/unrelated listener on the fixed loopback port can answer
          // before our child reports EADDRINUSE. Require the spawned process
          // to remain alive across a short post-probe grace period too.
          await sleep(HEALTH_POLL_MS);
          if (!childHasExited(processRef)) return true;
        }
      }
    } catch {
      // Listener/catalog warm-up can race the first few probes.
    }
    await sleep(HEALTH_POLL_MS);
  }
  return false;
}

export function buildOmniEnvironment(
  credentials: StoredFreeModelSourceCredentials,
  dataDir: string,
  routerKey: string,
  internalToken: string,
  adminPassword: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOST: OMNI_HOST,
    PORT: String(OMNI_PORT),
    ROUTER_KEY: routerKey,
    AUTH_TOKEN: internalToken,
    ADMIN_PASSWORD: adminPassword,
    OMNI_DATA_DIR: dataDir,
    GLM_TOKEN_DB: path.join(dataDir, "glm-tokens.sqlite"),
    AGENT_MODE: "true",
    RTK: "off",
    PROMPT_MODE: "off",
    RETRY_PER_PROVIDER: "1",
    QWEN_TOKEN: credentials.qwenToken ?? "",
    QWEN_TOKENS: "",
    ZAI_TOKEN: credentials.glmToken ?? "",
    ZAI_TOKENS: "",
    DEEPSEEK_TOKENS: credentials.deepseekToken ?? "",
    GEMINI_COOKIES: credentials.geminiCookies ?? "",
    FREEBUFF_TOKENS: credentials.freebuffToken ?? "",
    OPENCODE_API_KEY: "",
    LOG_LEVEL: "warn",
  };

  // Do not inherit the bot's process.env: it can contain Telegram, GitHub,
  // Railway and provider secrets unrelated to OmniRouter. Only harmless
  // runtime hints needed by Go/TLS/temp handling are copied explicitly.
  for (const key of ["SSL_CERT_FILE", "SSL_CERT_DIR", "TMPDIR", "TZ", "LANG", "LC_ALL"] as const) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

async function startFreeModelSourcesInternal(): Promise<boolean> {
  if (omniReady && omniProcess && !childHasExited(omniProcess)) return true;

  const routerKey = ensureSecret(ROUTER_KEY_ENV, "sk-otb-");
  const internalToken = ensureSecret(INTERNAL_TOKEN_ENV);
  const adminPassword = ensureSecret(ADMIN_PASSWORD_ENV);
  const credentials = await readCredentials();
  const dataDir = path.join(getRuntimePaths().appHome, "omnirouter");
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });

  let spawnError: Error | null = null;
  const child = spawn(executablePath(), [], {
    env: buildOmniEnvironment(credentials, dataDir, routerKey, internalToken, adminPassword),
    stdio: "ignore",
    windowsHide: true,
  });
  omniProcess = child;
  child.once("error", (error) => {
    spawnError = error;
    logger.warn("[FreeModelSources] OmniRouter failed to spawn", error);
  });
  child.once("exit", (code, signal) => {
    if (omniProcess === child) {
      omniProcess = null;
      omniReady = false;
      discoveredModels = {};
    }
    if (code !== 0 && code !== null) {
      logger.warn(`[FreeModelSources] OmniRouter exited: code=${code}, signal=${signal ?? "none"}`);
    }
  });

  try {
    const ready = await waitForOmni(child, () => spawnError);
    if (!ready) throw new Error("OmniRouter did not become ready");
    await discoverAllModels(internalToken);
    if (childHasExited(child)) throw new Error("OmniRouter exited during model discovery");
    omniReady = true;
    logger.info(
      "[FreeModelSources] OmniRouter ready: " +
      SOURCES.map((source) => `${source.id}=${discoveredModels[source.id]?.length ?? 0}`).join(","),
    );
    return true;
  } catch (error) {
    omniReady = false;
    discoveredModels = {};
    await terminateChild(child);
    if (omniProcess === child) omniProcess = null;
    logger.warn("[FreeModelSources] OmniRouter unavailable; experimental sources stay disabled for this runtime", error);
    return false;
  }
}

async function stopFreeModelSourcesInternal(): Promise<void> {
  const child = omniProcess;
  omniProcess = null;
  omniReady = false;
  discoveredModels = {};
  if (!child) return;
  await terminateChild(child);
}

export function startFreeModelSources(): Promise<boolean> {
  return enqueueLifecycle(startFreeModelSourcesInternal);
}

export function initializeFreeModelSources(): Promise<boolean> {
  return enqueueLifecycle(async () => {
    if (!getFreeModelSourcesEnabled()) return false;
    return startFreeModelSourcesInternal();
  });
}

export function stopFreeModelSources(): Promise<void> {
  return enqueueLifecycle(stopFreeModelSourcesInternal);
}

export function restartFreeModelSources(): Promise<boolean> {
  return enqueueLifecycle(async () => {
    await stopFreeModelSourcesInternal();
    if (!getFreeModelSourcesEnabled()) return false;
    return startFreeModelSourcesInternal();
  });
}

export function toggleFreeModelSources(): Promise<{ enabled: boolean; success: boolean }> {
  return enqueueLifecycle(async () => {
    const enable = !getFreeModelSourcesEnabled();
    if (enable) {
      const started = await startFreeModelSourcesInternal();
      if (!started) return { enabled: false, success: false };
      await setFreeModelSourcesEnabled(true);
      return { enabled: true, success: true };
    }

    await setFreeModelSourcesEnabled(false);
    await stopFreeModelSourcesInternal();
    return { enabled: false, success: true };
  });
}
