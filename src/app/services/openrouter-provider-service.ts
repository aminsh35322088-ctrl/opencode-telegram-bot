import { discoverModels, getCustomProvider, saveCustomProvider } from "./custom-provider-service.js";
import { asRecord, readBoundedJson } from "./ai-http-service.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_PROVIDER_ID = "builtin-openrouter";

export async function verifyOpenRouterApiKey(apiKey: string): Promise<void> {
  const key = apiKey.trim(); if (!key) throw new Error("OpenRouter API key is empty");
  const response = await fetch(`${OPENROUTER_BASE_URL}/key`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000), redirect: "error" });
  const data = asRecord(asRecord(await readBoundedJson(response, 64 * 1024)).data);
  if (data.is_management_key === true || data.is_provisioning_key === true) throw new Error("Use an OpenRouter inference key, not a management key");
  if (data.is_management_key !== false && data.is_provisioning_key !== false) throw new Error("OpenRouter could not confirm the key type");
}
export async function configureOpenRouterCodingProvider(apiKey: string, beforeSave: () => void = () => {}): Promise<void> {
  const existing = await getCustomProvider(OPENROUTER_PROVIDER_ID);
  if (existing && (existing.baseURL !== OPENROUTER_BASE_URL || existing.capability !== "coding")) throw new Error("The built-in OpenRouter ID belongs to another connection. Rename that connection first.");
  await verifyOpenRouterApiKey(apiKey);
  const models = await discoverModels(OPENROUTER_BASE_URL, apiKey);
  beforeSave();
  await saveCustomProvider({ id: OPENROUTER_PROVIDER_ID, name: "OpenRouter", baseURL: OPENROUTER_BASE_URL, apiKey, models, capability: "coding", beforeSave });
}
