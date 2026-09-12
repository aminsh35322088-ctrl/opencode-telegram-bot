import {
  discoverModels,
  saveCustomProvider,
  type CustomProvider,
} from "./custom-provider-service.js";

export const OPENROUTER_PROVIDER_ID = "openrouter";
export const OPENROUTER_PROVIDER_NAME = "OpenRouter";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

interface OpenRouterCurrentKeyResponse {
  data?: {
    is_management_key?: boolean;
    is_provisioning_key?: boolean;
  };
}

export async function verifyOpenRouterApiKey(apiKey: string): Promise<void> {
  const key = apiKey.trim();
  if (!key) throw new Error("OpenRouter API key is empty");

  const response = await fetch(`${OPENROUTER_BASE_URL}/key`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `OpenRouter API key verification failed: HTTP ${response.status}${detail ? ` — ${detail.slice(0, 180)}` : ""}`,
    );
  }

  const payload = (await response.json().catch(() => null)) as OpenRouterCurrentKeyResponse | null;
  if (!payload?.data) throw new Error("OpenRouter returned an invalid key verification response");
  if (payload.data.is_management_key || payload.data.is_provisioning_key) {
    throw new Error("Use a regular OpenRouter inference API key, not a management/provisioning key");
  }
}

export async function configureOpenRouterCodingProvider(apiKey: string): Promise<CustomProvider> {
  const key = apiKey.trim();
  await verifyOpenRouterApiKey(key);

  const models = await discoverModels(OPENROUTER_BASE_URL, key);
  return saveCustomProvider({
    id: OPENROUTER_PROVIDER_ID,
    name: OPENROUTER_PROVIDER_NAME,
    baseURL: OPENROUTER_BASE_URL,
    apiKey: key,
    models,
    capability: "coding",
  });
}
