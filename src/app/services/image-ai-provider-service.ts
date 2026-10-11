import type { ImageBinary, ImageModelSelection } from "../types/image-model.js";
import { readBoundedJson, detectImageMimeType } from "./ai-http-service.js";
import { readAppState, updateAppState } from "../stores/app-state-store.js";
import { runOpenCodeImageModel } from "./opencode-image-execution-service.js";
import type { SessionOwner } from "@opencode-telegram/native-runtime";
import {
  removeExtensionCredentials,
  resolveExtensionCredential,
  saveExtensionCredential,
} from "./credential-vault-service.js";

export type ImageAiCapability = "generate" | "edit";
export interface ImageAiProviderStatus { id: string; name: string; model: string; editModel?: string; capabilities: ImageAiCapability[]; active: boolean; default: boolean; }
interface StoredImageAiProvider extends ImageAiProviderStatus {
  baseURL: string;
  credentialId: string;
  /** Legacy plaintext field, migrated to Credential Vault on first read. */
  apiKey?: string;
  updatedAt: string;
}
interface ResolvedImageAiProvider extends StoredImageAiProvider { apiKey: string; }
interface ImageAiStore { providers: StoredImageAiProvider[]; }

const CUSTOM_ID = "custom-image-ai";
const CUSTOM_CREDENTIAL_ID = "api-key";
const CUSTOM_EXTENSION_ID = "model-provider:custom-image-ai";

function getStore(state: Awaited<ReturnType<typeof readAppState>>): ImageAiStore {
  const raw = state.imageAi;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { providers: [] };
  const value = raw as Record<string, unknown>;

  const providers = Array.isArray(value.providers)
    ? value.providers
        .filter((candidate): candidate is Record<string, unknown> =>
          Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate))
        .flatMap((candidate) => {
          if (
            typeof candidate.id !== "string"
            || typeof candidate.name !== "string"
            || typeof candidate.baseURL !== "string"
            || typeof candidate.model !== "string"
            || typeof candidate.updatedAt !== "string"
            || !Array.isArray(candidate.capabilities)
          ) {
            return [];
          }
          const hasCredentialId =
            typeof candidate.credentialId === "string" && candidate.credentialId.trim();
          const legacyApiKey =
            typeof candidate.apiKey === "string" ? candidate.apiKey.trim() : "";
          if (!hasCredentialId && !legacyApiKey) return [];

          const capabilities = candidate.capabilities.filter(
            (cap): cap is ImageAiCapability => cap === "generate" || cap === "edit",
          );
          const provider: StoredImageAiProvider = {
            id: candidate.id,
            name: candidate.name,
            baseURL: candidate.baseURL,
            model: candidate.model,
            ...(typeof candidate.editModel === "string" && candidate.editModel.trim()
              ? { editModel: candidate.editModel.trim() }
              : {}),
            capabilities,
            active: candidate.active === true,
            default: candidate.default === true,
            credentialId: hasCredentialId ? String(candidate.credentialId).trim() : CUSTOM_CREDENTIAL_ID,
            ...(legacyApiKey ? { apiKey: legacyApiKey } : {}),
            updatedAt: candidate.updatedAt,
          };
          return [provider];
        })
    : [];

  return { providers };
}

async function readStore(): Promise<ImageAiStore> {
  return getStore(await readAppState());
}
async function writeStore(store: ImageAiStore, beforeSave: () => void = () => {}): Promise<void> {
  await updateAppState(() => { beforeSave(); return { imageAi: store }; });
  const { invalidateUnifiedModelCatalog } = await import("./unified-model-catalog-service.js");
  invalidateUnifiedModelCatalog();
}
function status(
  provider: StoredImageAiProvider,
  defaultId?: string,
): ImageAiProviderStatus {
  const result: ImageAiProviderStatus = {
    id: provider.id,
    name: provider.name,
    model: provider.model,
    capabilities: provider.capabilities,
    active: provider.active,
    default: provider.active && provider.id === defaultId,
  };
  if (provider.editModel) result.editModel = provider.editModel;
  return result;
}

export async function migrateLegacyImageAiCredentials(): Promise<number> {
  const store = await readStore();
  let migrated = 0;
  let changed = false;

  for (const provider of store.providers) {
    const legacy = provider.apiKey?.trim();
    if (!legacy) continue;
    const current = await resolveExtensionCredential(
      CUSTOM_EXTENSION_ID,
      provider.credentialId,
    );
    if (!current) {
      await saveExtensionCredential(CUSTOM_EXTENSION_ID, provider.credentialId, legacy);
      migrated += 1;
    }
    delete provider.apiKey;
    changed = true;
  }



  if (changed) await writeStore(store);
  return migrated;
}

async function imageProviderApiKey(provider: StoredImageAiProvider): Promise<string> {
  const legacy = provider.apiKey?.trim();
  if (legacy) return legacy;
  return (
    await resolveExtensionCredential(CUSTOM_EXTENSION_ID, provider.credentialId)
  )?.trim() ?? "";
}


export async function listImageAiProviders(): Promise<ImageAiProviderStatus[]> {
  await migrateLegacyImageAiCredentials();
  const store = await readStore();
  const defaultId = store.providers.find((provider) => provider.active)?.id;
  return store.providers.map((provider) => status(provider, defaultId));
}

export async function getActiveImageAiProviders(): Promise<ResolvedImageAiProvider[]> {
  await migrateLegacyImageAiCredentials();
  const store = await readStore();
  const custom: ResolvedImageAiProvider[] = [];

  for (const provider of store.providers) {
    if (!provider.active) continue;
    const apiKey = await imageProviderApiKey(provider);
    if (!apiKey) continue;
    custom.push({ ...provider, apiKey });
  }

  return custom;
}
function parseError(payload: unknown, httpStatus: number): string { if (payload && typeof payload === "object" && "error" in payload) { const value = (payload as Record<string, unknown>).error; return typeof value === "string" ? value : JSON.stringify(value); } return `HTTP ${httpStatus}`; }
async function readBody(response: Response): Promise<unknown> { const text = await response.text(); if (!text) return null; try { return JSON.parse(text); } catch { return text; } }
async function fetchRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> { let lastError: unknown; for (let i = 0; i < attempts; i += 1) { try { const response = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) }); if (![429, 502, 503, 504].includes(response.status) || i === attempts - 1) return response; const retryAfter = Number(response.headers.get("retry-after") ?? ""); const delay = retryAfter > 0 && retryAfter < 30 ? retryAfter * 1000 : 1000 * (i + 1); await new Promise((resolve) => setTimeout(resolve, delay)); } catch (error) { lastError = error; if (i + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1))); } } throw lastError instanceof Error ? lastError : new Error("Image provider request failed"); }
function imageBufferFromOpenAiResult(body: unknown): Buffer { const data = body && typeof body === "object" && Array.isArray((body as Record<string, unknown>).data) ? (body as { data: unknown[] }).data : []; const first = data[0]; const b64 = first && typeof first === "object" ? (first as Record<string, unknown>).b64_json : undefined; if (typeof b64 !== "string" || !b64) throw new Error("Custom image API returned no b64_json image data"); return Buffer.from(b64, "base64"); }
async function runCustomOpenAiCompatible(provider: ResolvedImageAiProvider, key: string, prompt: string, image?: Buffer, mimeType = "image/png", signal?: AbortSignal): Promise<{ buffer: Buffer; mimeType: string }> { const baseURL = provider.baseURL.replace(/\/+$/g, ""); if (image) { const form = new FormData(); form.append("model", provider.editModel ?? provider.model); form.append("prompt", prompt); form.append("image", new Blob([new Uint8Array(image)], { type: mimeType }), "input.png");     const response = await imageRequest(`${baseURL}/images/edits`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form }, signal); if (!response.ok) { const errBody = await readBody(response); throw new Error(`Custom image editing failed: ${parseError(errBody, response.status)}`); } const body = signal ? await readBoundedJson(response) : await readBody(response); return { buffer: imageBufferFromOpenAiResult(body), mimeType: "image/png" }; } const response = await imageRequest(`${baseURL}/images/generations`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: provider.model, prompt, response_format: "b64_json" }) }, signal); if (!response.ok) { const errBody = await readBody(response); throw new Error(`Custom image generation failed: ${parseError(errBody, response.status)}`); } const body = signal ? await readBoundedJson(response) : await readBody(response); return { buffer: imageBufferFromOpenAiResult(body), mimeType: "image/png" }; }

export async function configureImageAiProvider(
  id: string,
  apiKey: string,
  options?: { baseURL?: string; model?: string; editModel?: string; name?: string },
  beforeSave: () => void = () => {},
): Promise<void> {
  const key = apiKey.trim();
  if (!key) throw new Error("API key is empty");
  if (id !== CUSTOM_ID) throw new Error(`Unknown Image AI provider: ${id}`);

  const baseURL = (options?.baseURL ?? "").replace(/\/+$/g, "");
  if (!baseURL) throw new Error("Custom API base URL is required.");
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new Error("Custom API base URL is invalid.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Custom API base URL must use http:// or https://");
  }

  const response = await fetch(`${baseURL}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await readBody(response);
  if (!response.ok) {
    throw new Error(`Custom API verification failed: ${parseError(body, response.status)}`);
  }

  const modelItems =
    body
    && typeof body === "object"
    && Array.isArray((body as Record<string, unknown>).data)
      ? (body as { data: unknown[] }).data
      : [];
  const ids = new Set(
    modelItems
      .filter((item) =>
        item
        && typeof item === "object"
        && typeof (item as Record<string, unknown>).id === "string")
      .map((item) => String((item as Record<string, unknown>).id)),
  );
  const model = options?.model?.trim();
  const editModel = options?.editModel?.trim();
  if (!model) throw new Error("Generation model is required.");
  if (!ids.has(model)) {
    throw new Error(`Custom API does not expose generation model "${model}".`);
  }
  if (editModel && !ids.has(editModel)) {
    throw new Error(`Custom API does not expose edit model "${editModel}".`);
  }

  const store = await readStore();
  const provider: StoredImageAiProvider = {
    id: CUSTOM_ID,
    name: options?.name?.trim() || "Custom API",
    baseURL,
    model,
    ...(editModel ? { editModel } : {}),
    capabilities: editModel ? ["generate", "edit"] : ["generate"],
    active: true,
    default: false,
    credentialId: CUSTOM_CREDENTIAL_ID,
    updatedAt: new Date().toISOString(),
  };
  await saveExtensionCredential(CUSTOM_EXTENSION_ID, CUSTOM_CREDENTIAL_ID, key);
  await writeStore({
    ...store,
    providers: [...store.providers.filter((item) => item.id !== CUSTOM_ID), provider],
  }, beforeSave);
}

export async function removeImageAiProvider(id: string): Promise<boolean> {
  if (id !== CUSTOM_ID) return false;
  const store = await readStore();
  const provider = store.providers.find((item) => item.id === id);
  if (!provider) return false;
  await writeStore({
    ...store,
    providers: store.providers.filter((item) => item.id !== id),
  });
  await removeExtensionCredentials(CUSTOM_EXTENSION_ID);
  return true;
}
export const IMAGE_AI_PROVIDER_IDS = { CUSTOM_ID } as const;

async function imageRequest(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  if (!signal) return fetchRetry(url, init);
  signal.throwIfAborted();
  return fetch(url, { ...init, signal, redirect: "error" });
}

export async function runImageForSelection(
  selection: ImageModelSelection,
  prompt: string,
  image: ImageBinary | undefined,
  signal: AbortSignal,
  worktree = process.cwd(),
  owner?: SessionOwner,
): Promise<ImageBinary> {
  if (image && detectImageMimeType(image.buffer) !== image.mimeType) {
    throw new Error("Only valid PNG, JPEG and WebP images are supported");
  }

  signal.throwIfAborted();

  const provider = (await getActiveImageAiProviders()).find((candidate) =>
    candidate.id === selection.providerID);

  if (provider) {
    if (
      provider.model !== selection.modelID
      || (provider.editModel ?? provider.model) !== (selection.editModelID ?? selection.modelID)
      || !provider.capabilities.includes(image ? "edit" : "generate")
    ) {
      throw new Error("The selected Image Model is unavailable or changed. Choose it again in Settings.");
    }
    if (provider.id !== CUSTOM_ID) throw new Error("Unsupported Image Model provider.");
    const result = await runCustomOpenAiCompatible(
      provider,
      provider.apiKey,
      prompt,
      image?.buffer,
      image?.mimeType,
      signal,
    );

    const mimeType = detectImageMimeType(result.buffer);
    if (!mimeType) throw new Error("Image provider returned an unsupported image format");
    return { buffer: result.buffer, mimeType };
  }

  // Normal AI providers are executed through OpenCode itself. This keeps the
  // image path provider-agnostic (Gemini/OpenRouter/custom gateways/etc.).
  return runOpenCodeImageModel(selection, prompt, image, signal, worktree, owner);
}

/** Dedicated chats pin one image connection. No fallback or ambiguous POST retry. */
