import fs from "node:fs/promises";
import path from "node:path";
import { getRuntimePaths } from "../../runtime/paths.js";
import { logger } from "../../utils/logger.js";
import { discoverProviderModels, type DiscoveredProviderModel } from "./model-verification-service.js";
import type { FreeModelConfidence, FreeModelStatus, ModelPricing } from "./model-verification-service.js";

export type AiCapability = "coding" | "image" | "video" | "stt";
export interface CustomProviderModel {
  id: string;
  name: string;
  freeStatus?: FreeModelStatus;
  freeConfidence?: FreeModelConfidence;
  freeReason?: string;
  pricing?: ModelPricing;
}
export interface CustomProvider { id: string; name: string; baseURL: string; models: CustomProviderModel[]; capability: AiCapability; createdAt: string; updatedAt: string; }
interface StoredProvider extends CustomProvider { keyFile: string; }
interface StoredSttProvider { provider: "groq"; keyFile: string; model: string; updatedAt: string; }
interface ProviderStoreFile { providers: StoredProvider[]; stt?: StoredSttProvider; }

const STORE_FILENAME = "custom-providers.json";
const PROVIDER_DIR = "providers";
const STT_KEY_FILE = path.join(PROVIDER_DIR, "groq-stt.key");
const GROQ_STT_BASE_URL = "https://api.groq.com/openai/v1";
const GROQ_STT_MODEL = "whisper-large-v3";
const LEGACY_GEMINI_IMAGE_ID = "gemini-image";

function getStorePath(): string { return path.join(getRuntimePaths().appHome, STORE_FILENAME); }
function normalizeCapability(value: unknown): AiCapability { return value === "image" || value === "video" || value === "stt" ? value : "coding"; }
async function readStore(): Promise<ProviderStoreFile> {
  try {
    const raw = JSON.parse(await fs.readFile(getStorePath(), "utf8")) as Partial<ProviderStoreFile>;
    const providers = Array.isArray(raw.providers) ? raw.providers.map((provider) => ({ ...provider, capability: normalizeCapability(provider.capability) })) : [];
    return { providers, ...(raw.stt ? { stt: raw.stt } : {}) };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { providers: [] }; throw error; }
}
async function writeStore(store: ProviderStoreFile): Promise<void> { await fs.mkdir(getRuntimePaths().appHome, { recursive: true }); const temp = `${getStorePath()}.tmp`; await fs.writeFile(temp, JSON.stringify(store, null, 2), { mode: 0o600 }); await fs.rename(temp, getStorePath()); }
function normalizeId(value: string): string { const id = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, ""); if (!id) throw new Error("Provider ID is empty"); return id.slice(0, 48); }
function normalizeBaseURL(value: string): string { const url = new URL(value.trim()); if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Base URL must use http:// or https://"); return url.toString().replace(/\/$/, ""); }
function toPublicProvider(provider: StoredProvider): CustomProvider { return { id: provider.id, name: provider.name, baseURL: provider.baseURL, models: provider.models, capability: normalizeCapability(provider.capability), createdAt: provider.createdAt, updatedAt: provider.updatedAt }; }
function toCustomProviderModel(model: DiscoveredProviderModel): CustomProviderModel {
  return {
    id: model.id,
    name: model.name,
    freeStatus: model.freeStatus,
    freeConfidence: model.freeConfidence,
    freeReason: model.freeReason,
    ...(model.pricing ? { pricing: model.pricing } : {}),
  };
}

export async function listCustomProviders(): Promise<CustomProvider[]> { const store = await readStore(); return store.providers.filter((p) => p.id !== LEGACY_GEMINI_IMAGE_ID).map(toPublicProvider); }
export async function listCustomProvidersByCapability(capability: AiCapability): Promise<CustomProvider[]> { return (await listCustomProviders()).filter((p) => p.capability === capability); }
export async function getCustomProvider(id: string): Promise<CustomProvider | undefined> { const store = await readStore(); const provider = store.providers.find((item) => item.id === id); return provider && provider.id !== LEGACY_GEMINI_IMAGE_ID ? toPublicProvider(provider) : undefined; }
export async function getCustomProviderConfig(id: string): Promise<{ apiUrl: string; apiKey: string; models: CustomProviderModel[]; capability: AiCapability } | undefined> { const store = await readStore(); const provider = store.providers.find((item) => item.id === id && item.id !== LEGACY_GEMINI_IMAGE_ID); if (!provider) return undefined; try { const apiKey = (await fs.readFile(path.join(getRuntimePaths().appHome, provider.keyFile), "utf8")).trim(); return apiKey ? { apiUrl: provider.baseURL, apiKey, models: provider.models, capability: normalizeCapability(provider.capability) } : undefined; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
export async function discoverModels(baseURL: string, apiKey: string): Promise<CustomProviderModel[]> {
  return (await discoverProviderModels(baseURL, apiKey)).map(toCustomProviderModel);
}
export async function testProvider(baseURL: string, apiKey: string): Promise<void> { await discoverModels(baseURL, apiKey); }

export async function configureGroqStt(apiKey: string): Promise<void> { const key = apiKey.trim(); if (!key) throw new Error("API key is empty"); const response = await fetch(`${GROQ_STT_BASE_URL}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) }); if (!response.ok) { const detail = await response.text().catch(() => ""); throw new Error(`Groq API key verification failed: HTTP ${response.status}${detail ? ` — ${detail.slice(0, 180)}` : ""}`); } const payload = (await response.json()) as { data?: Array<{ id?: unknown }> }; if (!(payload.data ?? []).some((model) => model.id === GROQ_STT_MODEL)) throw new Error(`Groq account does not expose ${GROQ_STT_MODEL}`); const store = await readStore(); const absoluteKeyFile = path.join(getRuntimePaths().appHome, STT_KEY_FILE); await fs.mkdir(path.dirname(absoluteKeyFile), { recursive: true }); await fs.writeFile(absoluteKeyFile, `${key}\n`, { mode: 0o600 }); await writeStore({ ...store, stt: { provider: "groq", keyFile: STT_KEY_FILE, model: GROQ_STT_MODEL, updatedAt: new Date().toISOString() } }); logger.info(`[CustomProvider] Groq STT configured and verified: model=${GROQ_STT_MODEL}`); }
export async function getGroqSttConfig(): Promise<{ apiUrl: string; apiKey: string; model: string } | undefined> { const store = await readStore(); if (!store.stt) return undefined; try { const key = (await fs.readFile(path.join(getRuntimePaths().appHome, store.stt.keyFile), "utf8")).trim(); return key ? { apiUrl: GROQ_STT_BASE_URL, apiKey: key, model: store.stt.model } : undefined; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
export async function isGroqSttConfigured(): Promise<boolean> { return Boolean(await getGroqSttConfig()); }
export async function removeGroqStt(): Promise<boolean> { const store = await readStore(); if (!store.stt) return false; await fs.rm(path.join(getRuntimePaths().appHome, store.stt.keyFile), { force: true }); const next = { ...store }; delete next.stt; await writeStore(next); return true; }

export async function saveCustomProvider(input: { id?: string; name: string; baseURL: string; apiKey: string; models: CustomProviderModel[]; capability?: AiCapability }): Promise<CustomProvider> {
  const key = input.apiKey.trim(); if (!key) throw new Error("API key is empty");
  const name = input.name.trim().slice(0, 80); if (!name) throw new Error("Provider name is empty");
  const id = normalizeId(input.id ?? name); const baseURL = normalizeBaseURL(input.baseURL); const capability = normalizeCapability(input.capability);
  const requestedModels = Array.isArray(input.models) ? input.models.filter((model) => typeof model?.id === "string" && model.id.trim()).map((model) => ({ id: model.id.trim(), name: typeof model.name === "string" && model.name.trim() ? model.name.trim() : model.id.trim() })) : [];
  if (!requestedModels.length) throw new Error("At least one provider model is required");
  const discovered = await discoverModels(baseURL, key);
  const discoveredById = new Map(discovered.map((model) => [model.id, model]));
  const verifiedModels = requestedModels.map((model) => discoveredById.get(model.id)).filter((model): model is CustomProviderModel => !!model);
  if (!verifiedModels.length) throw new Error("None of the configured models were returned by the provider");
  const now = new Date().toISOString(); const store = await readStore(); const existing = store.providers.find((provider) => provider.id === id); const keyFile = existing?.keyFile ?? path.join(PROVIDER_DIR, `${id}.key`); const absoluteKeyFile = path.join(getRuntimePaths().appHome, keyFile);
  await fs.mkdir(path.dirname(absoluteKeyFile), { recursive: true }); await fs.writeFile(absoluteKeyFile, `${key}\n`, { mode: 0o600 });
  const provider: StoredProvider = { id, name, baseURL, models: verifiedModels, capability, keyFile, createdAt: existing?.createdAt ?? now, updatedAt: now };
  await writeStore({ ...store, providers: [...store.providers.filter((item) => item.id !== id), provider] });
  logger.info(`[CustomProvider] Saved verified provider ${id} capability=${capability} models=${provider.models.length} free=${provider.models.filter((model) => model.freeStatus === "free" && model.freeConfidence === "high").length}`); return toPublicProvider(provider);
}
export async function deleteCustomProvider(id: string): Promise<boolean> { const store = await readStore(); const provider = store.providers.find((item) => item.id === id); if (!provider) return false; await fs.rm(path.join(getRuntimePaths().appHome, provider.keyFile), { force: true }); await writeStore({ ...store, providers: store.providers.filter((item) => item.id !== id) }); return true; }
export async function buildOpenCodeCustomConfig(): Promise<string> { const store = await readStore(); const providers: Record<string, unknown> = {}; const appHome = getRuntimePaths().appHome; for (const provider of store.providers.filter((p) => p.id !== LEGACY_GEMINI_IMAGE_ID)) { const keyPath = path.resolve(appHome, provider.keyFile); try { const apiKey = (await fs.readFile(keyPath, "utf8")).trim(); if (!apiKey) { logger.warn(`[CustomProvider] Skipping provider ${provider.id}: key file is empty`); continue; } providers[provider.id] = { npm: "@ai-sdk/openai-compatible", name: provider.name, options: { baseURL: provider.baseURL, apiKey: `{file:${keyPath}}` }, models: Object.fromEntries(provider.models.map((model) => [model.id, { name: model.name }])) }; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { logger.warn(`[CustomProvider] Skipping provider ${provider.id}: key file missing (${keyPath})`); continue; } throw error; } } return JSON.stringify({ $schema: "https://opencode.ai/config.json", provider: providers }, null, 2); }
export async function syncOpenCodeCustomConfig(): Promise<string> { const configDir = path.join(getRuntimePaths().appHome, ".config", "opencode-telegram"); const configPath = path.join(configDir, "custom-providers.json"); await fs.mkdir(configDir, { recursive: true }); await fs.writeFile(configPath, await buildOpenCodeCustomConfig(), { mode: 0o600 }); return configPath; }
