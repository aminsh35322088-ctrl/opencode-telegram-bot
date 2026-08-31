import fs from "node:fs/promises";
import path from "node:path";
import { getRuntimePaths } from "../../runtime/paths.js";
import { logger } from "../../utils/logger.js";
import type { ImageAiCapability } from "./image-ai-provider-service.js";

type CostClass = "free" | "paid" | "unknown";
type Json = Record<string, unknown>;
interface ProviderRecord { id: string; name: string; model: string; editModel?: string; capabilities: ImageAiCapability[]; active: boolean; baseURL: string; keyFile: string; }
interface Store { providers?: ProviderRecord[]; }
export interface FreeImageModel { providerId: string; providerName: string; model: string; editModel?: string; capability: ImageAiCapability; cost: CostClass; reason: string; route: string; providerModel?: string; }
interface RouteHealth { failures: number; lastFailureAt: number; cooldownUntil: number; lastSuccessAt: number; }

const STORE = "image-ai-providers.json";
const CACHE_TTL_MS = 10 * 60_000;
const DISCOVERY_LIMIT = 40;
const HF_CONCURRENCY = 5;
const REQUEST_TIMEOUT_MS = 20_000;
const GENERATION_TIMEOUT_MS = 120_000;
const HEALTH_COOLDOWN_MS = [30_000, 120_000, 600_000];
let cache: { expiresAt: number; models: FreeImageModel[] } | undefined;
const routeHealth = new Map<string, RouteHealth>();

function storePath(): string { return path.join(getRuntimePaths().appHome, STORE); }
async function readStore(): Promise<ProviderRecord[]> {
  try { const value = JSON.parse(await fs.readFile(storePath(), "utf8")) as Store; return Array.isArray(value.providers) ? value.providers.filter((p) => p?.active && p?.keyFile) : []; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
async function readKey(provider: ProviderRecord): Promise<string | undefined> {
  try { return (await fs.readFile(path.join(getRuntimePaths().appHome, provider.keyFile), "utf8")).trim() || undefined; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function request(url: string, key?: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
  const headers = new Headers(init.headers); headers.set("Accept", "application/json"); if (key) headers.set("Authorization", `Bearer ${key}`);
  const response = await fetch(url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
  const text = await response.text(); let body: unknown = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`HTTP ${response.status}${body && typeof body === "object" && "error" in body ? `: ${String((body as Json).error)}` : ""}`);
  return body;
}
function asList(body: unknown): Json[] { if (Array.isArray(body)) return body.filter((x): x is Json => Boolean(x) && typeof x === "object"); if (body && typeof body === "object") { const data = (body as Json).data; if (Array.isArray(data)) return data.filter((x): x is Json => Boolean(x) && typeof x === "object"); } return []; }
function numericZero(value: unknown): boolean { return typeof value === "number" ? value === 0 : typeof value === "string" ? Number(value) === 0 : false; }
function pricingFree(pricing: unknown): boolean { if (!pricing || typeof pricing !== "object") return false; const values = Object.values(pricing as Json).filter((v) => v !== null && v !== undefined && v !== ""); return values.length > 0 && values.every(numericZero); }
function detectCost(model: Json): { cost: CostClass; reason: string } {
  if (model.is_free === true || model.free === true) return { cost: "free", reason: "provider explicitly reports the model as free" };
  if (pricingFree(model.pricing)) return { cost: "free", reason: "provider reports zero pricing" };
  if (model.pricing && typeof model.pricing === "object") return { cost: "paid", reason: "provider reports non-zero pricing" };
  return { cost: "unknown", reason: "provider did not expose machine-readable pricing" };
}
function isImageModel(model: Json): boolean {
  const architecture = model.architecture && typeof model.architecture === "object" ? model.architecture as Json : {};
  const input = Array.isArray(architecture.input_modalities) ? architecture.input_modalities.map(String) : [];
  const output = Array.isArray(architecture.output_modalities) ? architecture.output_modalities.map(String) : [];
  const tags = [model.pipeline_tag, model.task, ...(Array.isArray(model.capabilities) ? model.capabilities.map(String) : [])].map(String).join(" ").toLowerCase();
  const id = String(model.id ?? model.name ?? "").toLowerCase();
  return output.includes("image") || input.includes("image") || /text-to-image|image-generation|image-edit|image-to-image/.test(tags) || /flux|stable-diffusion|imagen|nano.?banana|gpt-image|kontext/.test(id);
}
function editCapable(model: Json): boolean { const text = JSON.stringify(model).toLowerCase(); return /image-edit|image-to-image|inpaint|kontext/.test(text); }
function modelRoute(baseURL: string, capability: ImageAiCapability): string { return `${baseURL.replace(/\/$/, "")}/images/${capability === "edit" ? "edits" : "generations"}`; }
function healthKey(model: FreeImageModel): string { return `${model.providerId}:${model.providerName}:${model.model}:${model.capability}:${model.route}`; }
function getHealth(model: FreeImageModel): RouteHealth { return routeHealth.get(healthKey(model)) ?? { failures: 0, lastFailureAt: 0, cooldownUntil: 0, lastSuccessAt: 0 }; }
function markSuccess(model: FreeImageModel): void { routeHealth.set(healthKey(model), { failures: 0, lastFailureAt: 0, cooldownUntil: 0, lastSuccessAt: Date.now() }); }
function markFailure(model: FreeImageModel): void { const previous = getHealth(model); const failures = Math.min(previous.failures + 1, HEALTH_COOLDOWN_MS.length); const cooldownUntil = Date.now() + HEALTH_COOLDOWN_MS[failures - 1]!; routeHealth.set(healthKey(model), { failures, lastFailureAt: Date.now(), cooldownUntil, lastSuccessAt: previous.lastSuccessAt }); }
function isCoolingDown(model: FreeImageModel): boolean { return getHealth(model).cooldownUntil > Date.now(); }
function routeScore(model: FreeImageModel): number { const health = getHealth(model); const age = health.lastSuccessAt ? Math.min((Date.now() - health.lastSuccessAt) / 3_600_000, 1) : 0.5; return (health.failures * 100) + (isCoolingDown(model) ? 10_000 : 0) - age; }
function orderCandidates(models: FreeImageModel[]): FreeImageModel[] { return models.filter((model) => !isCoolingDown(model)).sort((a, b) => routeScore(a) - routeScore(b)); }

async function detectOpenAiCompatible(provider: ProviderRecord, key: string): Promise<FreeImageModel[]> {
  const base = provider.baseURL.replace(/\/$/, "");
  let body: unknown;
  try { body = await request(`${base}/models`, key); } catch { body = await request(`${base}/v1/models`, key); }
  const result: FreeImageModel[] = [];
  for (const item of asList(body).slice(0, DISCOVERY_LIMIT)) {
    if (!isImageModel(item)) continue;
    const cost = detectCost(item); if (cost.cost !== "free") continue;
    const id = String(item.id ?? item.name ?? ""); if (!id) continue;
    const capability: ImageAiCapability = editCapable(item) ? "edit" : "generate";
    result.push({ providerId: provider.id, providerName: provider.name, model: id, capability, cost: "free", reason: cost.reason, route: modelRoute(base, capability) });
  }
  return result;
}
async function detectPollinations(provider: ProviderRecord): Promise<FreeImageModel[]> {
  const body = await request("https://gen.pollinations.ai/v1/models");
  const result: FreeImageModel[] = [];
  for (const item of asList(body)) {
    if (!isImageModel(item)) continue;
    const cost = detectCost(item); if (cost.cost !== "free") continue;
    const id = String(item.id ?? item.name ?? ""); if (!id) continue;
    const capability: ImageAiCapability = editCapable(item) ? "edit" : "generate";
    result.push({ providerId: provider.id, providerName: provider.name, model: id, capability, cost: "free", reason: cost.reason, route: modelRoute(provider.baseURL, capability) });
  }
  return result;
}
async function detectHuggingFace(provider: ProviderRecord, key: string): Promise<FreeImageModel[]> {
  const searchUrl = "https://huggingface.co/api/models?inference_provider=all&pipeline_tag=text-to-image&sort=downloads&direction=-1&limit=40";
  const catalog = asList(await request(searchUrl, key));
  const result: FreeImageModel[] = [];
  for (let index = 0; index < catalog.length && result.length < DISCOVERY_LIMIT; index += HF_CONCURRENCY) {
    const batch = catalog.slice(index, index + HF_CONCURRENCY);
    const discovered = await Promise.all(batch.map(async (model) => {
      const modelId = String(model.id ?? ""); if (!modelId) return [] as FreeImageModel[];
      try {
        const info = await request(`https://router.huggingface.co/v1/models/${encodeURIComponent(modelId)}`, key) as Json;
        const models: FreeImageModel[] = [];
        for (const entry of asList(info.providers)) {
          if (String(entry.status ?? "") !== "live") continue;
          const cost = detectCost(entry); if (cost.cost !== "free") continue;
          const providerName = String(entry.provider ?? ""); if (!providerName) continue;
          const providerModel = String(entry.provider_model ?? entry.providerModel ?? modelId);
          models.push({ providerId: provider.id, providerName: `${provider.name} / ${providerName}`, model: modelId, providerModel, capability: "generate", cost: "free", reason: cost.reason, route: `https://router.huggingface.co/${providerName}/models/${providerModel}` });
        }
        return models;
      } catch (error) { logger.debug?.(`[ImageAI] HF discovery skipped model=${modelId}: ${error instanceof Error ? error.message : String(error)}`); return [] as FreeImageModel[]; }
    }));
    result.push(...discovered.flat());
  }
  return result.slice(0, DISCOVERY_LIMIT);
}
async function detectProvider(provider: ProviderRecord, key: string): Promise<FreeImageModel[]> {
  if (provider.id === "pollinations") return detectPollinations(provider);
  if (provider.id === "huggingface") return detectHuggingFace(provider, key);
  return detectOpenAiCompatible(provider, key);
}
export async function detectFreeImageModels(force = false): Promise<FreeImageModel[]> {
  if (!force && cache && cache.expiresAt > Date.now()) return cache.models;
  const providers = await readStore();
  const results = await Promise.all(providers.map(async (provider) => {
    const key = await readKey(provider); if (!key) return [] as FreeImageModel[];
    try { const found = await detectProvider(provider, key); logger.info(`[ImageAI] free-model scan provider=${provider.id} found=${found.length}`); return found; }
    catch (error) { logger.warn(`[ImageAI] free-model scan failed provider=${provider.id}: ${error instanceof Error ? error.message : String(error)}`); return [] as FreeImageModel[]; }
  }));
  const models = results.flat(); cache = { expiresAt: Date.now() + CACHE_TTL_MS, models }; return models;
}
export function clearFreeImageModelCache(): void { cache = undefined; }
export async function freeImageStatus(): Promise<{ checkedAt: string; models: FreeImageModel[] }> { return { checkedAt: new Date().toISOString(), models: await detectFreeImageModels() }; }
async function imageResponse(response: Response, providerName: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const text = await response.text(); let body: unknown = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) { const detail = body && typeof body === "object" && "error" in body ? String((body as Json).error) : `HTTP ${response.status}`; throw new Error(`${providerName}: ${detail}`); }
  const item = body && typeof body === "object" && Array.isArray((body as Json).data) ? ((body as { data: Array<{ b64_json?: string; url?: string }> }).data[0]) : undefined;
  if (item?.b64_json) return { buffer: Buffer.from(item.b64_json, "base64"), mimeType: "image/png" };
  if (item?.url) { const image = await fetch(item.url, { signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS) }); if (!image.ok) throw new Error(`${providerName}: image download HTTP ${image.status}`); return { buffer: Buffer.from(await image.arrayBuffer()), mimeType: image.headers.get("content-type") ?? "image/png" }; }
  throw new Error(`${providerName}: no image data returned`);
}
async function execute(model: FreeImageModel, prompt: string, image?: Buffer, mimeType?: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const providers = await readStore(); const provider = providers.find((item) => item.id === model.providerId); if (!provider) throw new Error(`Free image provider ${model.providerId} is no longer configured.`);
  const key = await readKey(provider); if (!key) throw new Error(`Free image provider ${provider.id} has no API key.`);
  if (provider.id === "huggingface") {
    if (image) throw new Error("Hugging Face free image editing is not available through the verified discovery route.");
    const response = await fetch(model.route, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ inputs: prompt }), signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS) });
    if (!response.ok) { const text = await response.text(); throw new Error(`${model.providerName}: HTTP ${response.status} ${text.slice(0, 300)}`); }
    return { buffer: Buffer.from(await response.arrayBuffer()), mimeType: response.headers.get("content-type") ?? "image/png" };
  }
  if (image) {
    const form = new FormData(); form.append("model", model.model); form.append("prompt", prompt); form.append("response_format", "b64_json"); form.append("image", new Blob([new Uint8Array(image)], { type: mimeType ?? "image/png" }), "input.png");
    return imageResponse(await fetch(model.route, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS) }), model.providerName);
  }
  return imageResponse(await fetch(model.route, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: model.model, prompt, n: 1, response_format: "b64_json" }), signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS) }), model.providerName);
}
export async function generateFreeImage(prompt: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const errors: string[] = []; const models = orderCandidates((await detectFreeImageModels()).filter((m) => m.capability === "generate"));
  for (const model of models) { try { logger.info(`[ImageAI] free route provider=${model.providerId} model=${model.model} healthFailures=${getHealth(model).failures}`); const result = await execute(model, prompt); markSuccess(model); return result; } catch (error) { const message = error instanceof Error ? error.message : String(error); errors.push(`${model.providerName}: ${message}`); markFailure(model); logger.warn(`[ImageAI] free route failed provider=${model.providerId} model=${model.model} failures=${getHealth(model).failures} cooldownMs=${Math.max(0, getHealth(model).cooldownUntil - Date.now())}: ${message}`); clearFreeImageModelCache(); } }
  throw new Error(errors.length ? `No verified free image model succeeded.\n${errors.join("\n")}` : "No verified free image generation model is currently available.");
}
export async function editFreeImage(image: Buffer, mimeType: string, prompt: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const errors: string[] = []; const models = orderCandidates((await detectFreeImageModels()).filter((m) => m.capability === "edit"));
  for (const model of models) { try { logger.info(`[ImageAI] free edit route provider=${model.providerId} model=${model.model} healthFailures=${getHealth(model).failures}`); const result = await execute(model, prompt, image, mimeType); markSuccess(model); return result; } catch (error) { const message = error instanceof Error ? error.message : String(error); errors.push(`${model.providerName}: ${message}`); markFailure(model); logger.warn(`[ImageAI] free edit route failed provider=${model.providerId} model=${model.model} failures=${getHealth(model).failures} cooldownMs=${Math.max(0, getHealth(model).cooldownUntil - Date.now())}: ${message}`); clearFreeImageModelCache(); } }
  throw new Error(errors.length ? `No verified free image editing model succeeded.\n${errors.join("\n")}` : "No verified free image editing model is currently available.");
}
