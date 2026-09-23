import { opencodeClient } from "../../opencode/client.js";
import type { FavoriteModel, ProviderInfo } from "../types/model.js";
import type {
  AgentModelReadiness,
  AgentReadinessSource,
  UnifiedModelCatalogEntry,
} from "../types/model-capability.js";
import {
  ensureCustomProviderModelToolCapability,
  getCustomProvider,
  getGroqSttConfig,
  listCustomProviders,
  listCustomProvidersByCapability,
  type CustomProvider,
  type CustomProviderModel,
} from "./custom-provider-service.js";
import { listImageAiProviders } from "./image-ai-provider-service.js";
import { detectModelCapabilities } from "./model-capability-detection-service.js";
import { detectModelExecutionCapabilities } from "./model-execution-capability-service.js";
import { isChatModelMetadata } from "./model-eligibility-service.js";
import { isServerUnavailableError } from "../../utils/opencode-error.js";
import { logger } from "../../utils/logger.js";

const CATALOG_TTL_MS = 10 * 60 * 1000;
const COPILOT_PROVIDER_ID = "github-copilot";

export interface UnifiedRuntimePriceMetadata {
  fetchedAt: number;
  models: Array<[string, unknown]>;
}

interface CatalogSnapshot {
  entries: UnifiedModelCatalogEntry[];
  runtimePrices: Map<string, UnifiedRuntimePriceMetadata>;
  fetchedAt: number;
}

let cachedSnapshot: CatalogSnapshot | null = null;
let refreshInFlight: Promise<CatalogSnapshot> | null = null;

function key(providerID: string, modelID: string): string {
  return providerID + "\0" + modelID;
}

function advertisedName(metadata: unknown, fallback: string): string {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return fallback;
  const name = (metadata as { name?: unknown }).name;
  return typeof name === "string" && name.trim() ? name.trim() : fallback;
}

function runtimeReadiness(metadata: unknown): {
  state: AgentModelReadiness;
  source: AgentReadinessSource;
  reason?: string;
} {
  const detected = detectModelCapabilities(metadata, { source: "provider-metadata" }).capabilities;
  if (detected.operations.chat === false) {
    return {
      state: "unsupported",
      source: "opencode-runtime",
      reason: "Runtime metadata says chat is unsupported.",
    };
  }
  if (detected.agent.toolCalling === true) {
    return { state: "ready", source: "opencode-runtime" };
  }
  if (detected.agent.toolCalling === false) {
    return {
      state: "unsupported",
      source: "opencode-runtime",
      reason: "Runtime metadata says tool calling is unsupported.",
    };
  }
  return {
    state: "unverified",
    source: "opencode-runtime",
    reason: "Runtime tool capability is unknown.",
  };
}

function customReadiness(
  model: CustomProviderModel,
  runtimeMetadata?: unknown,
): { state: AgentModelReadiness; source: AgentReadinessSource; reason?: string } {
  if (!isChatModelMetadata(model)) {
    return {
      state: "unsupported",
      source: "provider-metadata",
      reason: "The provider metadata does not expose a chat model.",
    };
  }
  if (model.toolCallVerified === true && model.toolCall !== true) {
    return {
      state: "unsupported",
      source: "live-probe",
      reason: "A live tool-call verification completed without the required tool call.",
    };
  }
  if (model.toolCallVerified !== true) {
    return {
      state: "unverified",
      source: "live-probe",
      reason: "Tool calling has not been verified for this model yet.",
    };
  }
  if (!runtimeMetadata) {
    return {
      state: "unverified",
      source: "live-probe",
      reason: "Tool calling was verified, but the model is not present in the current OpenCode runtime catalog.",
    };
  }
  const runtime = runtimeReadiness(runtimeMetadata);
  if (runtime.state === "ready") {
    return { state: "ready", source: "opencode-runtime" };
  }
  return {
    state: "unverified",
    source: "opencode-runtime",
    reason: "Tool calling was verified, but the current OpenCode runtime has not confirmed the matching capability yet.",
  };
}

function customMetadata(model: CustomProviderModel): Record<string, unknown> {
  return {
    name: model.name,
    attachment: model.attachment,
    modalities: model.modalities,
    tool_call: model.toolCall === false
      ? false
      : model.toolCallVerified === true
        ? model.toolCall === true
        : undefined,
  };
}

function makeRuntimeEntry(
  providerID: string,
  providerName: string,
  modelID: string,
  metadata: unknown,
  customProvider?: CustomProvider,
): UnifiedModelCatalogEntry {
  const detected = detectModelCapabilities(metadata, { source: "provider-metadata" });
  const execution = detectModelExecutionCapabilities(metadata);
  const customModel = customProvider?.models.find((model) => model.id === modelID);
  return {
    providerID,
    providerName,
    modelID,
    modelName: advertisedName(metadata, customModel?.name || modelID),
    capabilities: detected.capabilities,
    execution: execution.execution,
    capabilityDetection: detected.detection,
    origin: customProvider ? "custom-provider" : "opencode-runtime",
    agentReadiness: customModel
      ? customReadiness(customModel, metadata)
      : runtimeReadiness(metadata),
    availability: "available",
  };
}

function makeCustomOnlyEntry(
  provider: CustomProvider,
  model: CustomProviderModel,
): UnifiedModelCatalogEntry {
  const detected = detectModelCapabilities(customMetadata(model), {
    source: "provider-metadata",
  });
  if (model.toolCallVerified !== true) {
    detected.capabilities.agent.toolCalling = "unknown";
  }
  return {
    providerID: provider.id,
    providerName: provider.name,
    modelID: model.id,
    modelName: model.name || model.id,
    capabilities: detected.capabilities,
    execution: {
      nativeAudioFileInput: "unknown",
      nativeAudioMimeTypes: [],
    },
    capabilityDetection: detected.detection,
    origin: "custom-provider",
    agentReadiness: customReadiness(model),
    availability: "unknown",
  };
}

async function buildSnapshot(): Promise<CatalogSnapshot> {
  const [providerResponse, customProviders, legacyImages, sttProviders, groq] =
    await Promise.all([
      opencodeClient.config.providers(),
      listCustomProviders(),
      listImageAiProviders(),
      listCustomProvidersByCapability("stt"),
      getGroqSttConfig(),
    ]);

  if (providerResponse.error || !providerResponse.data) {
    if (cachedSnapshot) {
      if (isServerUnavailableError(providerResponse.error)) {
        logger.warn(
          "[UnifiedCatalog] OpenCode is unavailable; keeping the last runtime catalog snapshot",
        );
      } else {
        logger.warn(
          "[UnifiedCatalog] Runtime catalog refresh failed; keeping the last snapshot",
          providerResponse.error,
        );
      }
      return cachedSnapshot;
    }

    if (isServerUnavailableError(providerResponse.error)) {
      logger.warn(
        "[UnifiedCatalog] OpenCode server is not running; using custom/adapter catalog only",
      );
    } else {
      logger.warn(
        "[UnifiedCatalog] Runtime catalog refresh failed; using custom/adapter catalog only",
        providerResponse.error,
      );
    }
  }

  const entries = new Map<string, UnifiedModelCatalogEntry>();
  const runtimePrices = new Map<string, UnifiedRuntimePriceMetadata>();
  const customById = new Map(
    customProviders.map((provider) => [provider.id, provider]),
  );
  const now = Date.now();

  for (const provider of providerResponse.data?.providers ?? []) {
    if (provider.id === COPILOT_PROVIDER_ID) continue;

    runtimePrices.set(provider.id, {
      fetchedAt: now,
      models: Object.entries(provider.models),
    });

    const custom = customById.get(provider.id);
    for (const [modelID, metadata] of Object.entries(provider.models)) {
      entries.set(
        key(provider.id, modelID),
        makeRuntimeEntry(
          provider.id,
          provider.name || provider.id,
          modelID,
          metadata,
          custom,
        ),
      );
    }
  }

  for (const provider of customProviders.filter(
    (item) => item.capability !== "stt",
  )) {
    for (const model of provider.models) {
      const modelKey = key(provider.id, model.id);
      if (!entries.has(modelKey)) {
        entries.set(modelKey, makeCustomOnlyEntry(provider, model));
      }
    }
  }

  for (const provider of legacyImages) {
    if (!provider.active) continue;

    const detected = detectModelCapabilities(
      {
        modalities: {
          input: provider.capabilities.includes("edit")
            ? ["text", "image"]
            : ["text"],
          output: ["image"],
        },
      },
      {
        source: "adapter",
        confidence: "high",
        forceImageGenerate: provider.capabilities.includes("generate"),
        forceImageEdit: provider.capabilities.includes("edit"),
      },
    );

    const modelKey = key(provider.id, provider.model);
    if (!entries.has(modelKey)) {
      entries.set(modelKey, {
        providerID: provider.id,
        providerName: provider.name,
        modelID: provider.model,
        modelName: provider.model,
        capabilities: detected.capabilities,
        execution: {
          nativeAudioFileInput: false,
          nativeAudioMimeTypes: [],
        },
        capabilityDetection: detected.detection,
        origin: "adapter",
        agentReadiness: {
          state: "unsupported",
          source: "adapter",
          reason: "Dedicated image adapter.",
        },
        availability: "available",
      });
    }
  }

  for (const provider of sttProviders) {
    for (const model of provider.models) {
      const detected = detectModelCapabilities(
        { modalities: { input: ["audio"], output: ["text"] } },
        {
          source: "adapter",
          confidence: "high",
          forceSpeechToText: true,
        },
      );

      const modelKey = key(provider.id, model.id);
      if (!entries.has(modelKey)) {
        entries.set(modelKey, {
          providerID: provider.id,
          providerName: provider.name,
          modelID: model.id,
          modelName: model.name || model.id,
          capabilities: detected.capabilities,
          execution: {
            nativeAudioFileInput: false,
            nativeAudioMimeTypes: [],
          },
          capabilityDetection: detected.detection,
          origin: "adapter",
          agentReadiness: {
            state: "unsupported",
            source: "adapter",
            reason: "Dedicated transcription adapter.",
          },
          availability: "available",
        });
      }
    }
  }

  if (groq) {
    const detected = detectModelCapabilities(
      { modalities: { input: ["audio"], output: ["text"] } },
      {
        source: "adapter",
        confidence: "high",
        forceSpeechToText: true,
      },
    );

    const modelKey = key("groq", groq.model);
    if (!entries.has(modelKey)) {
      entries.set(modelKey, {
        providerID: "groq",
        providerName: "Groq",
        modelID: groq.model,
        modelName: groq.model,
        capabilities: detected.capabilities,
        execution: {
          nativeAudioFileInput: false,
          nativeAudioMimeTypes: [],
        },
        capabilityDetection: detected.detection,
        origin: "adapter",
        agentReadiness: {
          state: "unsupported",
          source: "adapter",
          reason: "Dedicated transcription adapter.",
        },
        availability: "available",
      });
    }
  }

  return {
    entries: [...entries.values()],
    runtimePrices,
    fetchedAt: now,
  };
}

async function loadSnapshot(force = false): Promise<CatalogSnapshot> {
  if (
    !force &&
    cachedSnapshot &&
    Date.now() - cachedSnapshot.fetchedAt < CATALOG_TTL_MS
  ) {
    return cachedSnapshot;
  }

  if (refreshInFlight) {
    if (!force) return refreshInFlight;
    await refreshInFlight;
  }

  refreshInFlight = buildSnapshot()
    .then((snapshot) => {
      cachedSnapshot = snapshot;
      return snapshot;
    })
    .finally(() => {
      refreshInFlight = null;
    });

  return refreshInFlight;
}

export async function refreshUnifiedModelCatalog(): Promise<void> {
  await loadSnapshot(true);
}

export async function listUnifiedModelCatalog(options?: {
  force?: boolean;
}): Promise<UnifiedModelCatalogEntry[]> {
  return [...(await loadSnapshot(options?.force === true)).entries];
}

export async function findUnifiedModel(
  providerID: string,
  modelID: string,
  options?: { force?: boolean },
): Promise<UnifiedModelCatalogEntry | undefined> {
  return (await listUnifiedModelCatalog(options)).find(
    (entry) =>
      entry.providerID === providerID && entry.modelID === modelID,
  );
}

export async function listUnifiedChatModels(): Promise<UnifiedModelCatalogEntry[]> {
  return (await listUnifiedModelCatalog()).filter((entry) =>
    entry.origin !== "adapter" &&
    entry.availability !== "unavailable" &&
    entry.capabilities.operations.chat !== false,
  );
}

export async function listUnifiedChatProviders(): Promise<ProviderInfo[]> {
  const providers = new Map<string, ProviderInfo>();
  for (const entry of await listUnifiedChatModels()) {
    const current = providers.get(entry.providerID) ?? {
      id: entry.providerID,
      name: entry.providerName,
      modelCount: 0,
    };
    current.modelCount += 1;
    providers.set(entry.providerID, current);
  }
  return [...providers.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}

export async function listUnifiedChatModelsForProvider(providerID: string): Promise<FavoriteModel[]> {
  return (await listUnifiedChatModels())
    .filter((entry) => entry.providerID === providerID)
    .map((entry) => ({
      providerID: entry.providerID,
      modelID: entry.modelID,
      ...(entry.modelName !== entry.modelID ? { name: entry.modelName } : {}),
    }))
    .sort((a, b) => a.modelID.localeCompare(b.modelID));
}

export async function listUnifiedChatRefs(): Promise<FavoriteModel[]> {
  return (await listUnifiedChatModels()).map((entry) => ({
    providerID: entry.providerID,
    modelID: entry.modelID,
    ...(entry.modelName !== entry.modelID ? { name: entry.modelName } : {}),
  }));
}

export async function isUnifiedChatModelSelectable(providerID: string, modelID: string): Promise<boolean> {
  const entry = await findUnifiedModel(providerID, modelID);
  return Boolean(
    entry &&
    entry.origin !== "adapter" &&
    entry.availability !== "unavailable" &&
    entry.capabilities.operations.chat !== false,
  );
}

export async function listUnifiedAgentCandidates(): Promise<
  UnifiedModelCatalogEntry[]
> {
  return (await listUnifiedModelCatalog()).filter((entry) => {
    if (entry.capabilities.operations.chat === false) return false;

    const state = entry.agentReadiness?.state ?? "unverified";
    if (entry.origin === "custom-provider") {
      return state === "ready" || state === "unverified";
    }

    return state === "ready";
  });
}

export async function listUnifiedAgentReadyModels(): Promise<
  UnifiedModelCatalogEntry[]
> {
  return (await listUnifiedModelCatalog()).filter(
    (entry) =>
      entry.capabilities.operations.chat !== false &&
      entry.agentReadiness?.state === "ready",
  );
}

export async function listUnifiedAgentProviders(): Promise<ProviderInfo[]> {
  const candidates = await listUnifiedAgentCandidates();
  const ready = new Set(
    (await listUnifiedAgentReadyModels()).map((entry) =>
      key(entry.providerID, entry.modelID),
    ),
  );

  const providers = new Map<string, ProviderInfo>();
  const unverified = new Map<string, number>();

  for (const entry of candidates) {
    const current = providers.get(entry.providerID) ?? {
      id: entry.providerID,
      name: entry.providerName,
      modelCount: 0,
    };
    current.modelCount += 1;

    if (!ready.has(key(entry.providerID, entry.modelID))) {
      unverified.set(
        entry.providerID,
        (unverified.get(entry.providerID) ?? 0) + 1,
      );
    }

    providers.set(entry.providerID, current);
  }

  return [...providers.values()]
    .map((provider) => {
      const unchecked = unverified.get(provider.id) ?? 0;
      return unchecked > 0
        ? {
            ...provider,
            readyModelCount: provider.modelCount - unchecked,
            unverifiedModelCount: unchecked,
          }
        : provider;
    })
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );
}

export async function listUnifiedAgentModels(
  providerID: string,
): Promise<FavoriteModel[]> {
  return (await listUnifiedAgentCandidates())
    .filter((entry) => entry.providerID === providerID)
    .map((entry) => ({
      providerID: entry.providerID,
      modelID: entry.modelID,
      ...(entry.modelName !== entry.modelID
        ? { name: entry.modelName }
        : {}),
    }))
    .sort((a, b) => a.modelID.localeCompare(b.modelID));
}

export async function listUnifiedAgentReadyRefs(): Promise<FavoriteModel[]> {
  return (await listUnifiedAgentReadyModels()).map((entry) => ({
    providerID: entry.providerID,
    modelID: entry.modelID,
    ...(entry.modelName !== entry.modelID
      ? { name: entry.modelName }
      : {}),
  }));
}

export async function ensureUnifiedAgentModelReady(
  providerID: string,
  modelID: string,
): Promise<boolean> {
  let entry = await findUnifiedModel(providerID, modelID);
  if (entry?.agentReadiness?.state === "ready") return true;
  if (entry?.agentReadiness?.state === "unsupported") return false;

  const custom = await getCustomProvider(providerID);
  if (
    !custom ||
    !custom.models.some((model) => model.id === modelID)
  ) {
    return false;
  }

  const verified = await ensureCustomProviderModelToolCapability(
    providerID,
    modelID,
  );

  await refreshUnifiedModelCatalog();
  if (!verified) return false;

  entry = await findUnifiedModel(providerID, modelID);
  return entry?.agentReadiness?.state === "ready";
}

export function getUnifiedRuntimePriceMetadata(
  providerID: string,
): UnifiedRuntimePriceMetadata | undefined {
  return cachedSnapshot?.runtimePrices.get(providerID);
}

export async function getUnifiedProviderRevisionData(
  providerID: string,
): Promise<Array<Record<string, unknown>>> {
  return (await listUnifiedModelCatalog())
    .filter((entry) => entry.providerID === providerID)
    .map((entry) => ({
      modelID: entry.modelID,
      availability: entry.availability,
      origin: entry.origin,
    }))
    .sort((a, b) =>
      String(a.modelID).localeCompare(String(b.modelID)),
    );
}

export function invalidateUnifiedModelCatalog(): void {
  cachedSnapshot = null;
}

export function __resetUnifiedModelCatalogForTests(): void {
  cachedSnapshot = null;
  refreshInFlight = null;
}
