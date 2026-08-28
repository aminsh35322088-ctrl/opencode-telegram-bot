import fs from "node:fs/promises";
import path from "node:path";
import { getRuntimePaths } from "../../runtime/paths.js";
import { logger } from "../../utils/logger.js";

export interface CustomProviderModel {
  id: string;
  name: string;
}

export interface CustomProvider {
  id: string;
  name: string;
  baseURL: string;
  models: CustomProviderModel[];
  createdAt: string;
  updatedAt: string;
}

interface StoredProvider extends CustomProvider {
  keyFile: string;
}

interface ProviderStoreFile {
  providers: StoredProvider[];
}

const STORE_FILENAME = "custom-providers.json";
const PROVIDER_DIR = "providers";
const OPENROUTER_PROVIDER_ID = "openrouter";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const GLM_PROVIDER_ID = "glm-free";
const GLM_BASE_URL = "https://free.empero.org/v1";
const GLM_MODEL_ID = "glm-5.3-flash";
const OPENROUTER_FREE_ROUTER_ID = "openrouter/free";

function getStorePath(): string {
  return path.join(getRuntimePaths().appHome, STORE_FILENAME);
}

async function readStore(): Promise<ProviderStoreFile> {
  try {
    return JSON.parse(await fs.readFile(getStorePath(), "utf8")) as ProviderStoreFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { providers: [] };
    }
    throw error;
  }
}

async function writeStore(store: ProviderStoreFile): Promise<void> {
  const appHome = getRuntimePaths().appHome;
  await fs.mkdir(appHome, { recursive: true });
  const temp = `${getStorePath()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(store, null, 2), { mode: 0o600 });
  await fs.rename(temp, getStorePath());
}

function normalizeId(value: string): string {
  const id = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!id) throw new Error("Provider ID is empty");
  return id.slice(0, 48);
}

function normalizeBaseURL(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Base URL must use http:// or https://");
  }
  return url.toString().replace(/\/$/, "");
}

function toPublicProvider(provider: StoredProvider): CustomProvider {
  return {
    id: provider.id,
    name: provider.name,
    baseURL: provider.baseURL,
    models: provider.models,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}

export async function listCustomProviders(): Promise<CustomProvider[]> {
  const store = await readStore();
  return store.providers.map(toPublicProvider);
}

export async function getCustomProvider(id: string): Promise<CustomProvider | undefined> {
  const store = await readStore();
  const provider = store.providers.find((item) => item.id === id);
  return provider ? toPublicProvider(provider) : undefined;
}

export async function discoverModels(baseURL: string, apiKey: string): Promise<CustomProviderModel[]> {
  const response = await fetch(`${baseURL.replace(/\/$/, "")}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Model discovery failed: HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
    data?: Array<{ id?: unknown; name?: unknown }>;
  };
  const models = (payload.data ?? [])
    .filter((model) => typeof model.id === "string" && model.id.trim())
    .map((model) => ({
      id: model.id as string,
      name:
        typeof model.name === "string" && model.name.trim()
          ? model.name
          : (model.id as string),
    }));

  if (!models.length) {
    throw new Error("Provider returned no models from /models");
  }
  return models.slice(0, 100);
}

export async function testProvider(baseURL: string, apiKey: string): Promise<void> {
  await discoverModels(baseURL, apiKey);
}

export async function saveCustomProvider(input: {
  name: string;
  baseURL: string;
  apiKey: string;
  models: CustomProviderModel[];
}): Promise<CustomProvider> {
  if (!input.apiKey.trim()) throw new Error("API key is empty");
  const id = normalizeId(input.name);
  const baseURL = normalizeBaseURL(input.baseURL);

  if (id === GLM_PROVIDER_ID) {
    throw new Error(`Provider ID "${GLM_PROVIDER_ID}" is reserved for the built-in GLM provider`);
  }
  if (id === OPENROUTER_PROVIDER_ID && baseURL !== OPENROUTER_BASE_URL) {
    throw new Error(`Provider ID "${OPENROUTER_PROVIDER_ID}" is reserved for OpenRouter`);
  }

  const now = new Date().toISOString();
  const store = await readStore();
  const existing = store.providers.find((provider) => provider.id === id);
  const keyFile = existing?.keyFile ?? path.join(PROVIDER_DIR, `${id}.key`);
  const absoluteKeyFile = path.join(getRuntimePaths().appHome, keyFile);

  await fs.mkdir(path.dirname(absoluteKeyFile), { recursive: true });
  await fs.writeFile(absoluteKeyFile, `${input.apiKey.trim()}\n`, { mode: 0o600 });

  const provider: StoredProvider = {
    id,
    name: input.name.trim().slice(0, 80),
    baseURL,
    models: input.models.slice(0, 100),
    keyFile,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  await writeStore({
    providers: [...store.providers.filter((item) => item.id !== id), provider],
  });

  logger.info(`[CustomProvider] Saved provider ${id} with ${provider.models.length} models`);
  return toPublicProvider(provider);
}

export async function deleteCustomProvider(id: string): Promise<boolean> {
  const store = await readStore();
  const provider = store.providers.find((item) => item.id === id);
  if (!provider) return false;

  await fs.rm(path.join(getRuntimePaths().appHome, provider.keyFile), { force: true });
  await writeStore({
    providers: store.providers.filter((item) => item.id !== id),
  });
  return true;
}

function buildBuiltinProviders(): Record<string, unknown> {
  return {
    [GLM_PROVIDER_ID]: {
      npm: "@ai-sdk/openai-compatible",
      name: "GLM-5.3-Flash (Free)",
      options: {
        baseURL: GLM_BASE_URL,
        apiKey: "free",
      },
      models: {
        [GLM_MODEL_ID]: {
          name: "GLM-5.3-Flash",
        },
      },
    },
  };
}

export function isOpenRouterProviderId(id: string): boolean {
  return id === OPENROUTER_PROVIDER_ID;
}

export async function activateOpenRouter(apiKey: string): Promise<CustomProvider> {
  const normalizedKey = apiKey.trim();
  if (!normalizedKey) throw new Error("OpenRouter API key is empty");

  const discovered = await discoverModels(OPENROUTER_BASE_URL, normalizedKey);
  const freeModels = discovered.filter((model) => model.id.endsWith(":free"));
  const models: CustomProviderModel[] = [
    { id: OPENROUTER_FREE_ROUTER_ID, name: "OpenRouter Free Router" },
    ...freeModels.filter((model) => model.id !== OPENROUTER_FREE_ROUTER_ID),
  ];

  return saveCustomProvider({
    name: "OpenRouter",
    baseURL: OPENROUTER_BASE_URL,
    apiKey: normalizedKey,
    models: models.slice(0, 100),
  });
}

export async function buildOpenCodeCustomConfig(): Promise<string> {
  const store = await readStore();
  const providers: Record<string, unknown> = buildBuiltinProviders();
  const appHome = getRuntimePaths().appHome;

  for (const provider of store.providers) {
    const keyPath = path.resolve(appHome, provider.keyFile);
    providers[provider.id] = {
      npm: "@ai-sdk/openai-compatible",
      name: provider.name,
      options: {
        baseURL: provider.baseURL,
        apiKey: `{file:${keyPath}}`,
      },
      models: Object.fromEntries(
        provider.models.map((model) => [model.id, { name: model.name }]),
      ),
    };
  }

  return JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      provider: providers,
    },
    null,
    2,
  );
}

export async function syncOpenCodeCustomConfig(): Promise<string> {
  const configDir = path.join(
    getRuntimePaths().appHome,
    ".config",
    "opencode-telegram",
  );
  const configPath = path.join(configDir, "custom-providers.json");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, await buildOpenCodeCustomConfig(), { mode: 0o600 });
  return configPath;
}
