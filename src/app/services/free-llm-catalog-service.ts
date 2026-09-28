import fs from "node:fs/promises";
import path from "node:path";
import { getRuntimePaths } from "../../runtime/paths.js";
import { logger } from "../../utils/logger.js";

const CATALOG_REPO = "aminsh35322088-ctrl/Free-LLM-Catalog";
const CATALOG_REF = "main";
const CATALOG_PATH = "catalog.json";
const GITHUB_API_URL = `https://api.github.com/repos/${CATALOG_REPO}/contents/${CATALOG_PATH}?ref=${CATALOG_REF}`;
const RAW_URL = `https://raw.githubusercontent.com/${CATALOG_REPO}/${CATALOG_REF}/${CATALOG_PATH}`;
const REQUEST_TIMEOUT_MS = 8_000;
const MEMORY_TTL_MS = 15 * 60_000;
const CACHE_FILE = "free-llm-catalog-cache.json";

export type FreeLlmAuthMode = "none" | "public-anonymous-token" | "static-placeholder";
export type FreeLlmProviderStatus = "verified" | "adapter-required" | "native-contract" | "disabled";

export interface FreeLlmCatalogModel {
  id: string;
  name: string;
  context?: number;
  output?: number;
  toolCall?: boolean;
  reasoning?: boolean;
  modalities?: {
    input?: string[];
    output?: string[];
  };
}

export interface FreeLlmCatalogProvider {
  id: string;
  runtimeId?: string;
  name: string;
  status: FreeLlmProviderStatus;
  integration: string;
  enabledByDefault: boolean;
  baseURL?: string;
  modelsURL?: string;
  auth: {
    mode: FreeLlmAuthMode;
    userCredentialRequired: false;
    value?: string;
  };
  models: FreeLlmCatalogModel[];
}

export interface FreeLlmCatalog {
  schemaVersion: 1;
  generatedAt: string;
  providers: FreeLlmCatalogProvider[];
}

interface MemorySnapshot {
  catalog: FreeLlmCatalog;
  fetchedAt: number;
}

let memory: MemorySnapshot | null = null;
let inFlight: Promise<FreeLlmCatalog> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return values.length ? [...new Set(values)].slice(0, 16) : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function parseModel(value: unknown): FreeLlmCatalogModel | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!id || !name) return null;

  const modalities = isRecord(value.modalities)
    ? {
        ...(stringList(value.modalities.input) ? { input: stringList(value.modalities.input) } : {}),
        ...(stringList(value.modalities.output) ? { output: stringList(value.modalities.output) } : {}),
      }
    : undefined;

  return {
    id,
    name,
    ...(positiveInteger(value.context) ? { context: positiveInteger(value.context) } : {}),
    ...(positiveInteger(value.output) ? { output: positiveInteger(value.output) } : {}),
    ...(typeof value.toolCall === "boolean" ? { toolCall: value.toolCall } : {}),
    ...(typeof value.reasoning === "boolean" ? { reasoning: value.reasoning } : {}),
    ...(modalities && Object.keys(modalities).length ? { modalities } : {}),
  };
}

function safeHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" ? url.toString().replace(/\/$/, "") : undefined;
  } catch {
    return undefined;
  }
}

function parseProvider(value: unknown): FreeLlmCatalogProvider | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const runtimeId = typeof value.runtimeId === "string" ? value.runtimeId.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const integration = typeof value.integration === "string" ? value.integration.trim() : "";
  const status = value.status;
  const auth = isRecord(value.auth) ? value.auth : null;
  const authMode = auth?.mode;
  if (
    !/^[a-z0-9][a-z0-9-]*$/.test(id) ||
    (runtimeId && !/^[a-z0-9][a-z0-9-]*$/.test(runtimeId)) ||
    !name ||
    !integration ||
    !["verified", "adapter-required", "native-contract", "disabled"].includes(String(status)) ||
    !auth ||
    auth.userCredentialRequired !== false ||
    !["none", "public-anonymous-token", "static-placeholder"].includes(String(authMode))
  ) return null;

  const authValue = typeof auth.value === "string" ? auth.value.trim() : "";
  if (authMode !== "none" && !authValue) return null;
  const models = Array.isArray(value.models)
    ? value.models.map(parseModel).filter((model): model is FreeLlmCatalogModel => Boolean(model)).slice(0, 512)
    : [];

  return {
    id,
    ...(runtimeId ? { runtimeId } : {}),
    name,
    status: status as FreeLlmProviderStatus,
    integration,
    enabledByDefault: value.enabledByDefault === true,
    ...(safeHttpsUrl(value.baseURL) ? { baseURL: safeHttpsUrl(value.baseURL) } : {}),
    ...(safeHttpsUrl(value.modelsURL) ? { modelsURL: safeHttpsUrl(value.modelsURL) } : {}),
    auth: {
      mode: authMode as FreeLlmAuthMode,
      userCredentialRequired: false,
      ...(authValue ? { value: authValue } : {}),
    },
    models,
  };
}

export function parseFreeLlmCatalog(value: unknown): FreeLlmCatalog {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.generatedAt !== "string" || !Array.isArray(value.providers)) {
    throw new Error("Free LLM catalog has an unsupported or malformed schema.");
  }
  const providers = value.providers
    .map(parseProvider)
    .filter((provider): provider is FreeLlmCatalogProvider => Boolean(provider));
  if (!providers.length) throw new Error("Free LLM catalog contains no valid providers.");
  return { schemaVersion: 1, generatedAt: value.generatedAt, providers };
}

function cachePath(): string {
  return path.join(getRuntimePaths().appHome, CACHE_FILE);
}

async function readDiskCache(): Promise<FreeLlmCatalog | null> {
  try {
    return parseFreeLlmCatalog(JSON.parse(await fs.readFile(cachePath(), "utf8")) as unknown);
  } catch {
    return null;
  }
}

async function writeDiskCache(catalog: FreeLlmCatalog): Promise<void> {
  const target = cachePath();
  const temp = target + ".tmp";
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(temp, JSON.stringify(catalog, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(temp, target);
}

async function fetchCatalogFromGithub(): Promise<FreeLlmCatalog> {
  const token = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
  if (token) {
    const response = await fetch(GITHUB_API_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "opencode-telegram-bot/free-llm-catalog",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GitHub catalog request failed: HTTP ${response.status}`);
    const payload = await response.json() as unknown;
    if (!isRecord(payload) || payload.encoding !== "base64" || typeof payload.content !== "string") {
      throw new Error("GitHub returned an invalid catalog file payload.");
    }
    const decoded = Buffer.from(payload.content.replace(/\s+/g, ""), "base64").toString("utf8");
    return parseFreeLlmCatalog(JSON.parse(decoded) as unknown);
  }

  const response = await fetch(RAW_URL, {
    headers: { "User-Agent": "opencode-telegram-bot/free-llm-catalog" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Public catalog request failed: HTTP ${response.status}`);
  return parseFreeLlmCatalog(await response.json() as unknown);
}

export async function loadFreeLlmCatalog(options: { force?: boolean } = {}): Promise<FreeLlmCatalog> {
  const force = options.force === true;
  if (!force && memory && Date.now() - memory.fetchedAt < MEMORY_TTL_MS) return memory.catalog;
  if (inFlight) return inFlight;

  const request = (async () => {
    try {
      const catalog = await fetchCatalogFromGithub();
      memory = { catalog, fetchedAt: Date.now() };
      await writeDiskCache(catalog).catch((error) => logger.warn("[FreeLLMCatalog] Could not persist catalog cache", error));
      return catalog;
    } catch (error) {
      const cached = memory?.catalog ?? await readDiskCache();
      if (cached) {
        memory = { catalog: cached, fetchedAt: Date.now() };
        logger.warn("[FreeLLMCatalog] Remote refresh failed; using last-known-good catalog", error);
        return cached;
      }
      logger.warn("[FreeLLMCatalog] Catalog unavailable and no last-known-good cache exists", error);
      return { schemaVersion: 1, generatedAt: new Date(0).toISOString(), providers: [] };
    }
  })();

  inFlight = request;
  try {
    return await request;
  } finally {
    if (inFlight === request) inFlight = null;
  }
}

function modelConfig(model: FreeLlmCatalogModel): Record<string, unknown> {
  const input = model.modalities?.input?.length ? model.modalities.input : ["text"];
  const output = model.modalities?.output?.length ? model.modalities.output : ["text"];
  return {
    name: model.name,
    attachment: input.some((item) => item !== "text"),
    tool_call: model.toolCall === true,
    modalities: { input, output },
  };
}

export function buildOpenCodeProvidersFromCatalog(catalog: FreeLlmCatalog): Record<string, unknown> {
  const providers: Record<string, unknown> = {};
  for (const provider of catalog.providers) {
    if (
      provider.status !== "verified" ||
      provider.integration !== "direct-openai" ||
      provider.enabledByDefault !== true ||
      provider.auth.userCredentialRequired !== false ||
      !provider.baseURL ||
      provider.models.length === 0
    ) continue;

    const runtimeId = provider.runtimeId ?? provider.id;
    const options: Record<string, unknown> = { baseURL: provider.baseURL };
    if (provider.auth.mode !== "none" && provider.auth.value) options.apiKey = provider.auth.value;
    providers[runtimeId] = {
      npm: "@ai-sdk/openai-compatible",
      name: provider.name,
      options,
      models: Object.fromEntries(provider.models.map((model) => [model.id, modelConfig(model)])),
    };
  }
  return providers;
}

export async function buildFreeLlmOpenCodeProviders(): Promise<Record<string, unknown>> {
  return buildOpenCodeProvidersFromCatalog(await loadFreeLlmCatalog());
}

export async function getFreeLlmCatalogProvider(providerId: string): Promise<FreeLlmCatalogProvider | null> {
  const catalog = await loadFreeLlmCatalog();
  return catalog.providers.find((provider) => (provider.runtimeId ?? provider.id) === providerId) ?? null;
}

export function __resetFreeLlmCatalogForTests(): void {
  memory = null;
  inFlight = null;
}
