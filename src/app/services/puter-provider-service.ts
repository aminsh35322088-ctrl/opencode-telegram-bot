import { asRecord, readBoundedJson } from "./ai-http-service.js";
import { getCustomProvider, normalizeDiscoveredModel, type CustomProviderModel } from "./custom-provider-service.js";
import { updateAppState } from "../stores/app-state-store.js";
import { logger } from "../../utils/logger.js";

export const PUTER_BASE_URL = "https://api.puter.com/puterai/openai/v1";
export const PUTER_MODELS_URL = "https://api.puter.com/puterai/chat/models/details";
export const PUTER_PROVIDER_ID = "builtin-puter";

const VERIFY_MODEL_PREFERENCE = ["gpt-5.4-nano", "gpt-5-nano", "gemini-3.5-flash-lite"] as const;

function normalizeCatalogModels(payload: unknown): CustomProviderModel[] {
  const root = asRecord(payload);
  const rawModels = Array.isArray(root.models) ? root.models : Array.isArray(payload) ? payload : [];
  const models = rawModels
    .map((raw) => normalizeDiscoveredModel(asRecord(raw)))
    .filter((model): model is CustomProviderModel => Boolean(model));

  const unique = new Map<string, CustomProviderModel>();
  for (const model of models) if (!unique.has(model.id)) unique.set(model.id, model);
  return [...unique.values()];
}

export async function discoverPuterModels(authToken: string): Promise<CustomProviderModel[]> {
  const token = authToken.trim();
  if (!token) throw new Error("Puter auth token is empty");

  const response = await fetch(PUTER_MODELS_URL, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  const models = normalizeCatalogModels(await readBoundedJson(response, 8 * 1024 * 1024));
  if (!models.length) throw new Error("Puter returned no chat models");
  return models;
}

function chooseVerificationModel(models: CustomProviderModel[]): string {
  for (const id of VERIFY_MODEL_PREFERENCE) if (models.some((model) => model.id === id)) return id;
  return models[0]!.id;
}

export async function verifyPuterAuthToken(authToken: string, models?: CustomProviderModel[]): Promise<void> {
  const token = authToken.trim();
  if (!token) throw new Error("Puter auth token is empty");
  const catalog = models?.length ? models : await discoverPuterModels(token);
  const model = chooseVerificationModel(catalog);

  const response = await fetch(`${PUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with OK only." }],
      temperature: 1,
    }),
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });

  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) throw new Error("Puter rejected this auth token. Create a fresh token in the Puter dashboard.");
    if (response.status === 402) throw new Error("Puter rejected inference with HTTP 402. This account currently has no usable AI allowance/credit for the OpenAI-compatible endpoint.");
    throw new Error(`Puter inference verification failed (HTTP ${response.status}). Check account access, quota and service status.`);
  }

  const payload = asRecord(await readBoundedJson(response, 2 * 1024 * 1024));
  if (!Array.isArray(payload.choices)) throw new Error("Puter returned an unexpected OpenAI-compatible response");
}

function storedProviders(customProviders: unknown): unknown[] {
  const custom = asRecord(customProviders);
  return Array.isArray(custom.providers) ? custom.providers : [];
}

export async function configurePuterCodingProvider(authToken: string, beforeSave: () => void = () => {}): Promise<void> {
  const token = authToken.trim();
  if (!token) throw new Error("Puter auth token is empty");

  const existing = await getCustomProvider(PUTER_PROVIDER_ID);
  if (existing && (existing.baseURL !== PUTER_BASE_URL || existing.capability !== "coding")) {
    throw new Error("The built-in Puter ID belongs to another connection. Rename that connection first.");
  }

  const models = await discoverPuterModels(token);
  await verifyPuterAuthToken(token, models);

  const now = new Date().toISOString();
  await updateAppState((state) => {
    beforeSave();
    const custom = asRecord(state.customProviders);
    const providers = storedProviders(state.customProviders);
    const existingRaw = providers.find((provider) => asRecord(provider).id === PUTER_PROVIDER_ID);
    const existingCreatedAt = asRecord(existingRaw).createdAt;
    return {
      customProviders: {
        ...custom,
        providers: [
          ...providers.filter((provider) => asRecord(provider).id !== PUTER_PROVIDER_ID),
          {
            id: PUTER_PROVIDER_ID,
            name: "Puter AI",
            baseURL: PUTER_BASE_URL,
            models,
            capability: "coding",
            apiKey: token,
            createdAt: typeof existingCreatedAt === "string" ? existingCreatedAt : now,
            updatedAt: now,
          },
        ],
      },
    };
  });

  logger.info(`[Puter] Saved verified provider ${PUTER_PROVIDER_ID} models=${models.length}`);
}
