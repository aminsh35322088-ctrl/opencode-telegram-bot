import fs from "node:fs/promises";
import path from "node:path";
import { getRuntimePaths } from "../../runtime/paths.js";
import { getAiRoleSelection } from "./ai-role-selection-service.js";
import { logger } from "../../utils/logger.js";

export type ImageAiCapability = "generate" | "edit";
export interface ImageAiProviderStatus { id: string; name: string; model: string; editModel?: string; capabilities: ImageAiCapability[]; active: boolean; default: boolean; }
interface StoredImageAiProvider extends ImageAiProviderStatus { baseURL: string; keyFile: string; updatedAt: string; }
interface ImageAiStore { providers: StoredImageAiProvider[]; }
export interface CloudflareCredentialValidation { valid: boolean; reason?: "missing" | "invalid_account_id" | "unauthorized" | "inactive_token" | "no_workers_ai_access" | "network" | "api_error"; tokenStatus?: string; }

const STORE_FILENAME = "image-ai-providers.json";
const PROVIDER_DIR = "providers";
const CLOUDFLARE_ID = "cloudflare";
const POLLINATIONS_ID = "pollinations";
const HUGGINGFACE_ID = "huggingface";
const CUSTOM_ID = "custom-image-ai";
const RETIRED_IDS = new Set([POLLINATIONS_ID, HUGGINGFACE_ID]);
const CLOUDFLARE_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";
const CLOUDFLARE_BASE_URL = "https://api.cloudflare.com/client/v4";
let cloudflareValidationCache: { accountId: string; tokenFingerprint: string; expiresAt: number; result: CloudflareCredentialValidation } | null = null;

function storePath(): string { return path.join(getRuntimePaths().appHome, STORE_FILENAME); }
async function readStore(): Promise<ImageAiStore> { try { const value = JSON.parse(await fs.readFile(storePath(), "utf8")) as Partial<ImageAiStore>; return { providers: Array.isArray(value.providers) ? value.providers : [] }; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { providers: [] }; throw error; } }
async function writeStore(store: ImageAiStore): Promise<void> { await fs.mkdir(getRuntimePaths().appHome, { recursive: true }); const tmp = `${storePath()}.tmp`; await fs.writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 }); await fs.rename(tmp, storePath()); }
async function readKey(provider: StoredImageAiProvider): Promise<string | undefined> { if (provider.id === CLOUDFLARE_ID) return process.env.CLOUDFLARE_API_TOKEN?.trim() || undefined; try { const value = (await fs.readFile(path.join(getRuntimePaths().appHome, provider.keyFile), "utf8")).trim(); return value || undefined; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
function status(provider: StoredImageAiProvider, defaultId?: string): ImageAiProviderStatus { const result: ImageAiProviderStatus = { id: provider.id, name: provider.name, model: provider.model, capabilities: provider.capabilities, active: provider.active, default: provider.active && provider.id === defaultId }; if (provider.editModel) result.editModel = provider.editModel; return result; }
function cloudflareFromEnv(): StoredImageAiProvider | null { const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim(); const token = process.env.CLOUDFLARE_API_TOKEN?.trim(); if (!accountId || !token) return null; return { id: CLOUDFLARE_ID, name: "Cloudflare Workers AI", baseURL: `${CLOUDFLARE_BASE_URL}/accounts/${accountId}/ai/run`, model: CLOUDFLARE_MODEL, capabilities: ["generate", "edit"], active: true, default: true, keyFile: "", updatedAt: new Date().toISOString() }; }

export async function validateCloudflareCredentials(accountIdInput: string, tokenInput: string): Promise<CloudflareCredentialValidation> {
  const accountId = accountIdInput.trim();
  const token = tokenInput.trim();
  if (!accountId || !token) return { valid: false, reason: "missing" };
  if (!/^[a-f0-9]{32}$/i.test(accountId)) return { valid: false, reason: "invalid_account_id" };
  const tokenFingerprint = `${token.slice(0, 8)}:${token.length}`;
  if (cloudflareValidationCache && cloudflareValidationCache.accountId === accountId && cloudflareValidationCache.tokenFingerprint === tokenFingerprint && cloudflareValidationCache.expiresAt > Date.now()) return cloudflareValidationCache.result;
  try {
    const verifyResponse = await fetch(`${CLOUDFLARE_BASE_URL}/user/tokens/verify`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    const verifyBody = await readBody(verifyResponse);
    if (!verifyResponse.ok) {
      const result: CloudflareCredentialValidation = { valid: false, reason: verifyResponse.status === 401 ? "unauthorized" : "api_error" };
      cloudflareValidationCache = { accountId, tokenFingerprint, expiresAt: Date.now() + 30_000, result };
      return result;
    }
    const tokenResult = verifyBody && typeof verifyBody === "object" && "result" in verifyBody ? (verifyBody as Record<string, unknown>).result : undefined;
    const tokenStatus = tokenResult && typeof tokenResult === "object" ? (tokenResult as Record<string, unknown>).status : undefined;
    if (tokenStatus !== "active") {
      const result: CloudflareCredentialValidation = { valid: false, reason: "inactive_token", tokenStatus: typeof tokenStatus === "string" ? tokenStatus : undefined };
      cloudflareValidationCache = { accountId, tokenFingerprint, expiresAt: Date.now() + 30_000, result };
      return result;
    }
    const modelsResponse = await fetch(`${CLOUDFLARE_BASE_URL}/accounts/${accountId}/ai/models/search?search=flux-2-klein-4b`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    const modelsBody = await readBody(modelsResponse);
    if (!modelsResponse.ok) {
      const result: CloudflareCredentialValidation = { valid: false, reason: modelsResponse.status === 401 || modelsResponse.status === 403 ? "no_workers_ai_access" : "api_error", tokenStatus: "active" };
      cloudflareValidationCache = { accountId, tokenFingerprint, expiresAt: Date.now() + 30_000, result };
      return result;
    }
    const success = modelsBody && typeof modelsBody === "object" && "success" in modelsBody ? (modelsBody as Record<string, unknown>).success : true;
    if (success !== true) {
      const result: CloudflareCredentialValidation = { valid: false, reason: "no_workers_ai_access", tokenStatus: "active" };
      cloudflareValidationCache = { accountId, tokenFingerprint, expiresAt: Date.now() + 30_000, result };
      return result;
    }
    const result: CloudflareCredentialValidation = { valid: true, tokenStatus: "active" };
    cloudflareValidationCache = { accountId, tokenFingerprint, expiresAt: Date.now() + 5 * 60_000, result };
    return result;
  } catch (error) {
    logger.warn(`[ImageAI] Cloudflare credential validation failed: ${error instanceof Error ? error.message : String(error)}`);
    return { valid: false, reason: "network" };
  }
}

export async function validateConfiguredCloudflareCredentials(): Promise<CloudflareCredentialValidation> { return validateCloudflareCredentials(process.env.CLOUDFLARE_ACCOUNT_ID ?? "", process.env.CLOUDFLARE_API_TOKEN ?? ""); }

export async function listImageAiProviders(): Promise<ImageAiProviderStatus[]> { const store = await readStore(); const cloudflare = cloudflareFromEnv(); const configured = store.providers.filter((p) => p.id !== CLOUDFLARE_ID && !RETIRED_IDS.has(p.id)); const providers = cloudflare ? [cloudflare, ...configured] : configured; const defaultId = providers.find((p) => p.active)?.id; return providers.map((p) => status(p, defaultId)); }
export async function getActiveImageAiProviders(): Promise<StoredImageAiProvider[]> { const store = await readStore(); const cloudflare = cloudflareFromEnv(); const configured = store.providers.filter((p) => p.id !== CLOUDFLARE_ID && !RETIRED_IDS.has(p.id) && p.active && Boolean(p.keyFile)); return cloudflare ? [cloudflare, ...configured] : configured; }
export async function hasActiveImageAiProvider(capability: ImageAiCapability): Promise<boolean> { return (await getActiveImageAiProviders()).some((p) => p.capabilities.includes(capability)); }
async function getOrderedImageProviders(): Promise<StoredImageAiProvider[]> { const providers = await getActiveImageAiProviders(); try { const selected = await getAiRoleSelection("image"); if (!selected) return providers; const index = providers.findIndex((p) => p.id === selected.providerID && (p.model === selected.modelID || p.editModel === selected.modelID)); if (index > 0) { const chosen = providers[index]; if (chosen) { providers.splice(index, 1); providers.unshift(chosen); } } } catch (error) { logger.warn("[ImageAI] Could not resolve Image AI Rule; using active-provider order:", error); } return providers; }
function parseError(payload: unknown, httpStatus: number): string { if (payload && typeof payload === "object" && "error" in payload) { const value = (payload as Record<string, unknown>).error; return typeof value === "string" ? value : JSON.stringify(value); } return `HTTP ${httpStatus}`; }
async function readBody(response: Response): Promise<unknown> { const text = await response.text(); if (!text) return null; try { return JSON.parse(text); } catch { return text; } }
async function fetchRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> { let lastError: unknown; for (let i = 0; i < attempts; i += 1) { try { const response = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) }); if (![429, 502, 503, 504].includes(response.status) || i === attempts - 1) return response; const retryAfter = Number(response.headers.get("retry-after") ?? ""); const delay = retryAfter > 0 && retryAfter < 30 ? retryAfter * 1000 : 1000 * (i + 1); await new Promise((resolve) => setTimeout(resolve, delay)); } catch (error) { lastError = error; if (i + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1))); } } throw lastError instanceof Error ? lastError : new Error("Image provider request failed"); }
function imageBufferFromResult(body: unknown): Buffer { const result = body && typeof body === "object" ? (body as Record<string, unknown>).result : undefined; const value = result && typeof result === "object" ? (result as Record<string, unknown>).image : undefined; if (typeof value !== "string" || !value) throw new Error("Cloudflare Workers AI returned no image data"); const match = value.match(/^data:[^;]+;base64,(.+)$/s); return Buffer.from(match?.[1] ?? value, "base64"); }
async function runCloudflare(provider: StoredImageAiProvider, key: string, prompt: string, image?: Buffer, mimeType = "image/png"): Promise<{ buffer: Buffer; mimeType: string }> { const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? ""; const validation = await validateCloudflareCredentials(accountId, key); if (!validation.valid) throw new Error(`Cloudflare credentials rejected: ${validation.reason}`); const form = new FormData(); form.append("prompt", prompt); form.append("width", "1024"); form.append("height", "768"); if (image) form.append("input_image_0", new Blob([new Uint8Array(image)], { type: mimeType }), "input.png"); const response = await fetchRetry(`${provider.baseURL}/${provider.model}`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form }); const body = await readBody(response); if (!response.ok) throw new Error(`Cloudflare Workers AI ${image ? "editing" : "generation"} failed: ${parseError(body, response.status)}`); return { buffer: imageBufferFromResult(body), mimeType: "image/png" }; }
export async function generateImageWithFallback(prompt: string) { const errors: string[] = []; for (const provider of await getOrderedImageProviders()) { if (!provider.capabilities.includes("generate")) continue; const key = await readKey(provider); if (!key) continue; try { logger.info(`[ImageAI] generate provider=${provider.id} model=${provider.model}`); return await runCloudflare(provider, key, prompt); } catch (error) { const message = error instanceof Error ? error.message : String(error); errors.push(`${provider.name}/${provider.model}: ${message}`); logger.warn(`[ImageAI] generate failed provider=${provider.id}: ${message}`); } } throw new Error(errors.length ? `All active image providers failed.\n${errors.join("\n")}` : "Cloudflare Workers AI is not configured. Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN."); }
export async function editImageWithFallback(image: Buffer, mimeType: string, prompt: string) { const errors: string[] = []; for (const provider of await getOrderedImageProviders()) { if (!provider.capabilities.includes("edit")) continue; const key = await readKey(provider); if (!key) continue; try { logger.info(`[ImageAI] edit provider=${provider.id} model=${provider.model}`); return await runCloudflare(provider, key, prompt, image, mimeType); } catch (error) { const message = error instanceof Error ? error.message : String(error); errors.push(`${provider.name}/${provider.model}: ${message}`); logger.warn(`[ImageAI] edit failed provider=${provider.id}: ${message}`); } } throw new Error(errors.length ? `All active image editing providers failed.\n${errors.join("\n")}` : "Cloudflare Workers AI is not configured. Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN."); }
export async function configureImageAiProvider(id: string, apiKey: string, options?: { baseURL?: string; model?: string; editModel?: string; name?: string }): Promise<void> { const key = apiKey.trim(); if (!key) throw new Error("API key is empty"); if (id === CLOUDFLARE_ID) throw new Error("Cloudflare Workers AI uses CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN environment variables."); if (id !== CUSTOM_ID) throw new Error(`Unknown image AI provider: ${id}`); const baseURL = (options?.baseURL ?? "").replace(/\/$/g, ""); if (!baseURL) throw new Error("Custom Image AI base URL is required."); const response = await fetch(`${baseURL}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) }); const body = await readBody(response); if (!response.ok) throw new Error(`Image AI provider verification failed: ${parseError(body, response.status)}`); const store = await readStore(); const provider: StoredImageAiProvider = { id: CUSTOM_ID, name: options?.name?.trim() || "Custom Image AI", baseURL, model: options?.model?.trim() || "default", editModel: options?.editModel?.trim(), capabilities: options?.editModel?.trim() ? ["generate", "edit"] : ["generate"], active: true, default: false, keyFile: `providers/${CUSTOM_ID}.key`, updatedAt: new Date().toISOString() }; await fs.mkdir(path.join(getRuntimePaths().appHome, PROVIDER_DIR), { recursive: true }); await fs.writeFile(path.join(getRuntimePaths().appHome, provider.keyFile), `${key}\n`, { mode: 0o600 }); await writeStore({ providers: [...store.providers.filter((p) => p.id !== CUSTOM_ID && p.id !== CLOUDFLARE_ID && !RETIRED_IDS.has(p.id)), provider] }); }
export async function configureBuiltInImageAiProvider(id: typeof CLOUDFLARE_ID | typeof POLLINATIONS_ID | typeof HUGGINGFACE_ID, _apiKey: string): Promise<void> { if (id !== CLOUDFLARE_ID) throw new Error(`${id} image provider has been retired. Use Cloudflare Workers AI.`); throw new Error("Cloudflare Workers AI is configured with CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN; do not store the token as a provider key."); }
export async function removeImageAiProvider(id: string): Promise<boolean> { if (id === CLOUDFLARE_ID || RETIRED_IDS.has(id)) return false; const store = await readStore(); const provider = store.providers.find((p) => p.id === id); if (!provider) return false; await fs.rm(path.join(getRuntimePaths().appHome, provider.keyFile), { force: true }); await writeStore({ providers: store.providers.filter((p) => p.id !== id) }); return true; }
export const IMAGE_AI_PROVIDER_IDS = { CLOUDFLARE_ID, POLLINATIONS_ID, HUGGINGFACE_ID, CUSTOM_ID } as const;
