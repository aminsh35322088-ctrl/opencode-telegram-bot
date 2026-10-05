import type { UnifiedModelCatalogEntry } from "../types/model-capability.js";
import { detectModelCapabilities } from "./model-capability-detection-service.js";
import { detectModelExecutionCapabilities } from "./model-execution-capability-service.js";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
/** Shared read-only adapter for Global metadata and the Bot model API. */
export function projectGlobalModelCatalog(
  runtime: Record<string, unknown>,
  state: Record<string, unknown>,
): UnifiedModelCatalogEntry[] {
  const entries: UnifiedModelCatalogEntry[] = [];
  const custom = record(state.customProviders).providers;
  const customIds = new Set((Array.isArray(custom) ? custom : []).map((value) => record(value).id));
  for (const [providerID, value] of Object.entries(record(runtime.provider))) {
    const provider = record(value);
    for (const [modelID, value] of Object.entries(record(provider.models))) {
      const metadata = record(value);
      const detected = detectModelCapabilities(metadata, { source: "model-catalog" });
      const execution = detectModelExecutionCapabilities(metadata);
      const ready = metadata.tool_call === true;
      entries.push({
        providerID,
        providerName: typeof provider.name === "string" ? provider.name : providerID,
        modelID,
        modelName: typeof metadata.name === "string" ? metadata.name : modelID,
        capabilities: detected.capabilities,
        execution: execution.execution,
        capabilityDetection: detected.detection,
        origin: customIds.has(providerID) ? "custom-provider" : "opencode-runtime",
        agentReadiness: {
          state: ready ? "ready" : "unverified",
          source: customIds.has(providerID) ? "live-probe" : "provider-metadata",
        },
        availability: "available",
      });
    }
  }
  // Adapter models are still Global capabilities; they do not pretend to be
  // executable through the OpenAI chat transport.
  const images = record(state.imageAi).providers;
  for (const value of Array.isArray(images) ? images : []) {
    const item = record(value);
    if (typeof item.id !== "string" || typeof item.model !== "string") continue;
    const detected = detectModelCapabilities(
      { imageGeneration: true, modalities: { input: ["text"], output: ["image"] } },
      { source: "adapter" },
    );
    entries.push({
      providerID: item.id,
      providerName: typeof item.name === "string" ? item.name : item.id,
      modelID: item.model,
      modelName: item.model,
      capabilities: detected.capabilities,
      capabilityDetection: detected.detection,
      origin: "adapter",
      agentReadiness: { state: "unsupported", source: "adapter" },
      availability: item.active === false ? "unavailable" : "available",
    });
  }
  return entries.sort((a, b) =>
    `${a.providerID}\0${a.modelID}`.localeCompare(`${b.providerID}\0${b.modelID}`),
  );
}
