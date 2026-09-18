import { opencodeClient } from "../../opencode/client.js";
import type { UnifiedModelCatalogEntry } from "../types/model-capability.js";
import { getGroqSttConfig, listCustomProvidersByCapability } from "./custom-provider-service.js";
import { listImageAiProviders } from "./image-ai-provider-service.js";
import { detectModelCapabilities } from "./model-capability-detection-service.js";

function advertisedName(metadata: unknown, fallback: string): string {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return fallback;
  const name = (metadata as { name?: unknown }).name;
  return typeof name === "string" && name.trim() ? name.trim() : fallback;
}

export async function listUnifiedModelCatalog(): Promise<UnifiedModelCatalogEntry[]> {
  const [providerResponse, legacyImages, sttProviders, groq] = await Promise.all([
    opencodeClient.config.providers(),
    listImageAiProviders(),
    listCustomProvidersByCapability("stt"),
    getGroqSttConfig(),
  ]);
  const entries: UnifiedModelCatalogEntry[] = [];

  if (!providerResponse.error && providerResponse.data) {
    for (const provider of providerResponse.data.providers) {
      for (const [modelID, metadata] of Object.entries(provider.models)) {
        const detected = detectModelCapabilities(metadata, { source: "provider-metadata" });
        entries.push({
          providerID: provider.id,
          providerName: provider.name || provider.id,
          modelID,
          modelName: advertisedName(metadata, modelID),
          capabilities: detected.capabilities,
          capabilityDetection: detected.detection,
          availability: "available",
        });
      }
    }
  }

  for (const provider of legacyImages) {
    if (!provider.active) continue;
    const detected = detectModelCapabilities({
      modalities: { input: provider.capabilities.includes("edit") ? ["text", "image"] : ["text"], output: ["image"] },
    }, {
      source: "adapter",
      confidence: "high",
      forceImageGenerate: provider.capabilities.includes("generate"),
      forceImageEdit: provider.capabilities.includes("edit"),
    });
    entries.push({ providerID: provider.id, providerName: provider.name, modelID: provider.model, modelName: provider.model, capabilities: detected.capabilities, capabilityDetection: detected.detection, availability: "available" });
  }

  for (const provider of sttProviders) {
    for (const model of provider.models) {
      const detected = detectModelCapabilities({ modalities: { input: ["audio"], output: ["text"] } }, { source: "adapter", confidence: "high", forceSpeechToText: true });
      entries.push({ providerID: provider.id, providerName: provider.name, modelID: model.id, modelName: model.name || model.id, capabilities: detected.capabilities, capabilityDetection: detected.detection, availability: "available" });
    }
  }
  if (groq) {
    const detected = detectModelCapabilities({ modalities: { input: ["audio"], output: ["text"] } }, { source: "adapter", confidence: "high", forceSpeechToText: true });
    entries.push({ providerID: "groq", providerName: "Groq", modelID: groq.model, modelName: groq.model, capabilities: detected.capabilities, capabilityDetection: detected.detection, availability: "available" });
  }

  const deduped = new Map<string, UnifiedModelCatalogEntry>();
  for (const entry of entries) {
    const key = `${entry.providerID}\0${entry.modelID}`;
    const existing = deduped.get(key);
    if (!existing || existing.capabilityDetection.confidence === "low") deduped.set(key, entry);
  }
  return [...deduped.values()].sort((a, b) => a.providerName.localeCompare(b.providerName) || a.modelName.localeCompare(b.modelName));
}

export async function findUnifiedModel(providerID: string, modelID: string): Promise<UnifiedModelCatalogEntry | undefined> {
  return (await listUnifiedModelCatalog()).find((entry) => entry.providerID === providerID && entry.modelID === modelID);
}
