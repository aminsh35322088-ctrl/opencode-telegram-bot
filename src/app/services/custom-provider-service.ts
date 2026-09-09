import fs from "node:fs/promises";
import path from "node:path";
import { getRuntimePaths } from "../../runtime/paths.js";
import { logger } from "../../utils/logger.js";
import { readAppState, updateAppState } from "../stores/app-state-store.js";

export type AiCapability = "coding" | "image" | "video" | "stt";

/**
 * OpenCode model capability metadata.
 * Custom / OpenAI-compatible /models endpoints are not consistent about how
 * they publish modalities, so we preserve the useful capability information
 * instead of collapsing every discovered model down to { id, name }.
 */
export interface CustomProviderModelModalities {
  input?: string[];
  output?: string[];
}

export interface CustomProviderModel {
  id: string;
  name: string;
  attachment?: boolean;
  modalities?: CustomProviderModelModalities;
}

export interface CustomProvider {
  id: string;
  name: string;
  baseURL: string;
  models: CustomProviderModel[];
  capability: AiCapability;
  createdAt: string;
  updatedAt: string;
}

interface StoredProvider extends CustomProvider {
  apiKey: string;
}
interface StoredSttProvider {
  provider: "groq";
  apiKey: string;
  model: string;
  updatedAt: string;
}
interface ProviderStoreFile {
  providers: StoredProvider[];
  stt?: StoredSttProvider;
}

const GROQ_STT_BASE_URL = "https://api.groq.com/openai/v1";
const GROQ_STT_MODEL = "whisper-large-v3";
const LEGACY_GEMINI_IMAGE_ID = "gemini-image";
const PROVIDER_ENV_PREFIX = "OPENCODE_TELEGRAM_PROVIDER_";
const DEFAULT_CUSTOM_MODEL_INPUT_MODALITIES = ["text", "image"] as const;
const DEFAULT_CUSTOM_MODEL_OUTPUT_MODALITIES = ["text"] as const;

const SUPPORTED_MODALITIES = new Set(["text", "audio", "image", "video", "pdf"]);

type DiscoveredModelRecord = Record<string, unknown>;

function normalizeCapability(value: unknown): AiCapability {
  return value === "image" || value === "video" || value === "stt" ? value : "coding";
}

function normalizeModalityList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => SUPPORTED_MODALITIES.has(item));
  return values.length ? [...new Set(values)] : undefined;
}

function readModalities(raw: DiscoveredModelRecord): CustomProviderModelModalities | undefined {
  const direct = raw.modalities;
  const architecture = raw.architecture;
  const capabilities = raw.capabilities;

  const directObject = direct && typeof direct === "object" ? (direct as Record<string, unknown>) : undefined;
  const architectureObject = architecture && typeof architecture === "object" ? (architecture as Record<string, unknown>) : undefined;
  const capabilitiesObject = capabilities && typeof capabilities === "object" ? (capabilities as Record<string, unknown>) : undefined;

  const input =
    normalizeModalityList(directObject?.input) ??
    normalizeModalityList(raw.input_modalities) ??
    normalizeModalityList(raw.inputModality) ??
    normalizeModalityList(architectureObject?.input_modalities) ??
    normalizeModalityList(capabilitiesObject?.input_modalities);

  const output =
    normalizeModalityList(directObject?.output) ??
    normalizeModalityList(raw.output_modalities) ??
    normalizeModalityList(raw.outputModality) ??
    normalizeModalityList(architectureObject?.output_modalities) ??
    normalizeModalityList(capabilitiesObject?.output_modalities);

  return input || output ? { ...(input ? { input } : {}), ...(output ? { output } : {}) } : undefined;
}

function readAttachmentFlag(raw: DiscoveredModelRecord, modalities?: CustomProviderModelModalities): boolean | undefined {
  for (const value of [raw.attachment, raw.supports_attachments, raw.supportsAttachments]) {
    if (typeof value === "boolean") return value;
  }

  if (modalities?.input) {
    return modalities.input.some((type) => type !== "text");
  }

  return undefined;
}

/**
 * Normalize an arbitrary OpenAI-compatible /models entry.
 *
 * The OpenAI API does not standardize multimodal metadata, so providers may
 * expose capabilities in several shapes. We accept the common forms and keep
 * them for the generated OpenCode config.
 */
export function normalizeDiscoveredModel(raw: DiscoveredModelRecord): CustomProviderModel | null {
  const idValue = raw.id;
  if (typeof idValue !== "string" || !idValue.trim()) return null;

  const id = idValue.trim();
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id;
  const modalities = readModalities(raw);
  const attachment = readAttachmentFlag(raw, modalities);

  return {
    id,
    name,
    ...(attachment !== undefined ? { attachment } : {}),
    ...(modalities ? { modalities } : {}),
  };
}

/**
 * OpenCode's custom-provider loader otherwise defaults custom models to
 * text-only. That is unsafe for arbitrary OpenAI-compatible gateways because
 * /models usually does not advertise modality metadata at all.
 *
 * Preserve explicit provider metadata; when it is absent, use an optimistic
 * multimodal input declaration so OpenCode does not silently strip an image
 * before the request reaches the provider. A genuinely text-only backend may
 * reject the image at the API boundary, but it will no longer be misclassified
 * and have the attachment replaced by a fabricated "not supported" message.
 */
export function getOpenCodeCustomModelConfig(model: CustomProviderModel): Record<string, unknown> {
  const explicitModalities = model.modalities;
  const input = explicitModalities?.input?.length ? explicitModalities.input : [...DEFAULT_CUSTOM_MODEL_INPUT_MODALITIES];
  const output = explicitModalities?.output?.length ? explicitModalities.output : [...DEFAULT_CUSTOM_MODEL_OUTPUT_MODALITIES];
  const attachment = model.attachment ?? input.some((type) => type !== "text");

  return {
    name: model.name,
    attachment,
    modalities: {
      input,
      output,
    },
  };
}

function normalizeStore(value: unknown): ProviderStoreFile {
  if (!value || typeof value !== "object") return { providers: [] };
  const raw = value as Partial<ProviderStoreFile>;
  const providers = Array.isArray(raw.providers)
    ? raw.providers
        .filter((provider): provider is StoredProvider => Boolean(provider) && typeof provider.id === "string" && typeof provider.apiKey === "string")
        .map((provider) => ({
          ...provider,
          capability: normalizeCapability(provider.capability),
          models: Array.isArray(provider.models)
            ? provider.models
                .filter((model): model is CustomProviderModel => Boolean(model) && typeof model.id === "string")
                .map((model) => ({
                  id: model.id,
                  name: typeof model.name === "string" && model.name.trim() ? model.name : model.id,
                  ...(typeof model.attachment === "boolean" ? { attachment: model.attachment } : {}),
                  ...(model.modalities ? { modalities: model.modalities } : {}),
                }))
            : [],
        }))
    : [];
  const stt = raw.stt && typeof raw.stt === "object" && typeof raw.stt.apiKey === "string"
    ? { ...(raw.stt as StoredSttProvider), provider: "groq" as const }
    : undefined;
  return stt ? { providers, stt } : { providers };
}

async function readStore(): Promise<ProviderStoreFile> {
  const state = await readAppState();
  return normalizeStore(state.customProviders);
}

async function writeStore(store: ProviderStoreFile): Promise<void> {
  await updateAppState({ customProviders: normalizeStore(store) });
}

function normalizeId(value: string): string {
  const id = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!id) throw new Error("Provider ID is empty");
  return id.slice(0, 48);
}

function normalizeBaseURL(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Base URL must use http:// or https://");
  return url.toString().replace(/\/$/, "");
}

function toPublicProvider(provider: StoredProvider): CustomProvider {
  return {
    id: provider.id,
    name: provider.name,
    baseURL: provider.baseURL,
    models: provider.models,
    capability: normalizeCapability(provider.capability),
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}

function envKey(id: string): string {
  return `${PROVIDER_ENV_PREFIX}${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

function applyProviderEnvironment(store: ProviderStoreFile): void {
  for (const key of Object.keys(process.env)) if (key.startsWith(PROVIDER_ENV_PREFIX)) delete process.env[key];
  for (const provider of store.providers) if (provider.apiKey.trim()) process.env[envKey(provider.id)] = provider.apiKey.trim();
  if (store.stt?.apiKey.trim()) process.env[`${PROVIDER_ENV_PREFIX}GROQ_STT_API_KEY`] = store.stt.apiKey.trim();
}

export async function listCustomProviders(): Promise<CustomProvider[]> {
  const store = await readStore();
  applyProviderEnvironment(store);
  return store.providers.filter((p) => p.id !== LEGACY_GEMINI_IMAGE_ID).map(toPublicProvider);
}

export async function listCustomProvidersByCapability(capability: AiCapability): Promise<CustomProvider[]> {
  return (await listCustomProviders()).filter((p) => p.capability === capability);
}

export async function getCustomProvider(id: string): Promise<CustomProvider | undefined> {
  const store = await readStore();
  applyProviderEnvironment(store);
  const provider = store.providers.find((item) => item.id === id);
  return provider && provider.id !== LEGACY_GEMINI_IMAGE_ID ? toPublicProvider(provider) : undefined;
}

export async function getCustomProviderConfig(id: string): Promise<{ apiUrl: string; apiKey: string; models: CustomProviderModel[]; capability: AiCapability } | undefined> {
  const store = await readStore();
  applyProviderEnvironment(store);
  const provider = store.providers.find((item) => item.id === id && item.id !== LEGACY_GEMINI_IMAGE_ID);
  return provider?.apiKey?.trim()
    ? { apiUrl: provider.baseURL, apiKey: provider.apiKey.trim(), models: provider.models, capability: normalizeCapability(provider.capability) }
    : undefined;
}

export async function discoverModels(baseURL: string, apiKey: string): Promise<CustomProviderModel[]> {
  const normalizedURL = normalizeBaseURL(baseURL);
  const key = apiKey.trim();
  if (!key) throw new Error("API key is empty");

  const response = await fetch(`${normalizedURL}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Model discovery failed: HTTP ${response.status}`);

  const payload = (await response.json()) as { data?: DiscoveredModelRecord[] };
  const models = (payload.data ?? [])
    .map(normalizeDiscoveredModel)
    .filter((model): model is CustomProviderModel => Boolean(model));

  if (!models.length) throw new Error("Provider returned no models from /models");
  return models;
}

export async function testProvider(baseURL: string, apiKey: string): Promise<void> {
  await discoverModels(baseURL, apiKey);
}

export async function configureGroqStt(apiKey: string): Promise<void> {
  const key = apiKey.trim();
  if (!key) throw new Error("API key is empty");
  const response = await fetch(`${GROQ_STT_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Groq API key verification failed: HTTP ${response.status}${detail ? ` — ${detail.slice(0, 180)}` : ""}`);
  }
  const payload = (await response.json()) as { data?: Array<{ id?: unknown }> };
  if (!(payload.data ?? []).some((model) => model.id === GROQ_STT_MODEL)) throw new Error(`Groq account does not expose ${GROQ_STT_MODEL}`);
  const store = await readStore();
  await writeStore({ ...store, stt: { provider: "groq", apiKey: key, model: GROQ_STT_MODEL, updatedAt: new Date().toISOString() } });
  applyProviderEnvironment({ ...store, stt: { provider: "groq", apiKey: key, model: GROQ_STT_MODEL, updatedAt: new Date().toISOString() } });
  logger.info(`[CustomProvider] Groq STT configured and verified: model=${GROQ_STT_MODEL}`);
}

export async function getGroqSttConfig(): Promise<{ apiUrl: string; apiKey: string; model: string } | undefined> {
  const store = await readStore();
  applyProviderEnvironment(store);
  return store.stt?.apiKey?.trim() ? { apiUrl: GROQ_STT_BASE_URL, apiKey: store.stt.apiKey.trim(), model: store.stt.model } : undefined;
}

export async function isGroqSttConfigured(): Promise<boolean> {
  return Boolean(await getGroqSttConfig());
}

export async function removeGroqStt(): Promise<boolean> {
  const store = await readStore();
  if (!store.stt) return false;
  delete store.stt;
  await writeStore(store);
  applyProviderEnvironment(store);
  return true;
}

export async function saveCustomProvider(input: {
  id?: string;
  name: string;
  baseURL: string;
  apiKey: string;
  models: CustomProviderModel[];
  capability?: AiCapability;
}): Promise<CustomProvider> {
  const key = input.apiKey.trim();
  if (!key) throw new Error("API key is empty");
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new Error("Provider name is empty");
  const id = normalizeId(input.id ?? name);
  const baseURL = normalizeBaseURL(input.baseURL);
  const capability = normalizeCapability(input.capability);
  const requestedModels = Array.isArray(input.models)
    ? input.models
        .filter((model) => typeof model?.id === "string" && model.id.trim())
        .map((model) => ({
          id: model.id.trim(),
          name: typeof model.name === "string" && model.name.trim() ? model.name.trim() : model.id.trim(),
          ...(typeof model.attachment === "boolean" ? { attachment: model.attachment } : {}),
          ...(model.modalities ? { modalities: model.modalities } : {}),
        }))
    : [];
  if (!requestedModels.length) throw new Error("At least one provider model is required");

  const discovered = await discoverModels(baseURL, key);
  const discoveredById = new Map(discovered.map((model) => [model.id, model]));
  const verifiedModels = requestedModels
    .map((model) => discoveredById.get(model.id))
    .filter((model): model is CustomProviderModel => Boolean(model));
  if (!verifiedModels.length) throw new Error("None of the configured models were returned by the provider");

  const now = new Date().toISOString();
  const store = await readStore();
  const existing = store.providers.find((provider) => provider.id === id);
  const provider: StoredProvider = {
    id,
    name,
    baseURL,
    models: verifiedModels,
    capability,
    apiKey: key,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const next = { ...store, providers: [...store.providers.filter((item) => item.id !== id), provider] };
  await writeStore(next);
  applyProviderEnvironment(next);
  logger.info(`[CustomProvider] Saved verified provider ${id} capability=${capability} models=${provider.models.length}`);
  return toPublicProvider(provider);
}

export async function deleteCustomProvider(id: string): Promise<boolean> {
  const store = await readStore();
  const provider = store.providers.find((item) => item.id === id);
  if (!provider) return false;
  const next = { ...store, providers: store.providers.filter((item) => item.id !== id) };
  await writeStore(next);
  applyProviderEnvironment(next);
  return true;
}

export async function buildOpenCodeCustomConfig(): Promise<string> {
  const store = await readStore();
  applyProviderEnvironment(store);
  const providers: Record<string, unknown> = {};

  for (const provider of store.providers.filter((p) => p.id !== LEGACY_GEMINI_IMAGE_ID)) {
    if (!provider.apiKey?.trim()) {
      logger.warn(`[CustomProvider] Skipping provider ${provider.id}: API key is empty`);
      continue;
    }

    providers[provider.id] = {
      npm: "@ai-sdk/openai-compatible",
      name: provider.name,
      options: {
        baseURL: provider.baseURL,
        apiKey: `{env:${envKey(provider.id)}}`,
      },
      models: Object.fromEntries(provider.models.map((model) => [model.id, getOpenCodeCustomModelConfig(model)])),
    };
  }

  return JSON.stringify({ $schema: "https://opencode.ai/config.json", provider: providers }, null, 2);
}

export async function syncOpenCodeCustomConfig(): Promise<string> {
  const configDir = path.join(getRuntimePaths().appHome, ".config", "opencode-telegram");
  const configPath = path.join(configDir, "custom-providers.json");
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(configPath, await buildOpenCodeCustomConfig(), { mode: 0o600 });
  return configPath;
}
