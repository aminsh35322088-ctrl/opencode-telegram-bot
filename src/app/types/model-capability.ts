export type CapabilityState = true | false | "unknown";
export type ModelModality = "text" | "image" | "audio" | "video" | "pdf";
export type CapabilityDetectionSource = "provider-metadata" | "model-catalog" | "adapter" | "endpoint" | "manual" | "heuristic";
export type CapabilityConfidence = "high" | "medium" | "low";

export interface ModelRef {
  providerID: string;
  modelID: string;
}

export interface UnifiedModelCapabilities {
  modalities: {
    input: Record<ModelModality, CapabilityState>;
    output: Record<ModelModality, CapabilityState>;
  };
  operations: {
    chat: CapabilityState;
    imageGenerate: CapabilityState;
    imageEdit: CapabilityState;
    speechToText: CapabilityState;
    textToSpeech: CapabilityState;
    videoGenerate: CapabilityState;
    embeddings: CapabilityState;
  };
  agent: {
    toolCalling: CapabilityState;
    reasoning: CapabilityState;
    structuredOutput: CapabilityState;
  };
  traits: {
    codingOptimized: CapabilityState;
  };
}

export interface ModelExecutionCapabilities {
  /** Whether the active OpenCode/provider transport can actually carry native audio FileParts. */
  nativeAudioFileInput: CapabilityState;
  /** Exact MIME types accepted by that verified transport. Supports audio/* for wildcard contracts. */
  nativeAudioMimeTypes: string[];
}

export type ModelCatalogOrigin = "opencode-runtime" | "custom-provider" | "adapter";
export type AgentModelReadiness = "ready" | "unverified" | "unsupported";
export type AgentReadinessSource = "opencode-runtime" | "live-probe" | "provider-metadata" | "adapter";

export interface UnifiedModelCatalogEntry {
  providerID: string;
  providerName: string;
  modelID: string;
  modelName: string;
  family?: string;
  capabilities: UnifiedModelCapabilities;
  execution?: ModelExecutionCapabilities;
  capabilityDetection: {
    source: CapabilityDetectionSource;
    confidence: CapabilityConfidence;
  };
  origin?: ModelCatalogOrigin;
  agentReadiness?: {
    state: AgentModelReadiness;
    source: AgentReadinessSource;
    reason?: string;
  };
  availability: "available" | "unavailable" | "unknown";
  experimentalFreeDetection?: {
    status: "possibly-free" | "possibly-paid" | "unknown";
    confidence?: "low" | "medium";
    checkedAt?: string;
  };
}

export type CapabilityRouteSource = "topic-override" | "primary-native" | "main-default" | "unavailable";

export type CapabilityBindingKey = "imageAI" | "speechToText" | "vision" | "textToSpeech";
export type CapabilityModelBindings = Partial<Record<CapabilityBindingKey, ModelRef>>;
export type ModelRoutingCapability = "imageGenerate" | "imageEdit" | "voiceInput" | "vision" | "textToSpeech";

export interface CapabilityRoute {
  capability: ModelRoutingCapability;
  model?: ModelRef;
  routeSource: CapabilityRouteSource;
  primarySupportsCapability: boolean;
  reason?: string;
}

export function cloneModelRef(ref: ModelRef | undefined): ModelRef | undefined {
  return ref ? { providerID: ref.providerID, modelID: ref.modelID } : undefined;
}

export function normalizeModelRef(value: unknown): ModelRef | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<ModelRef>;
  if (typeof candidate.providerID !== "string" || !candidate.providerID.trim()) return undefined;
  if (typeof candidate.modelID !== "string" || !candidate.modelID.trim()) return undefined;
  return { providerID: candidate.providerID.trim(), modelID: candidate.modelID.trim() };
}

export function cloneCapabilityBindings(bindings: CapabilityModelBindings | undefined): CapabilityModelBindings | undefined {
  if (!bindings) return undefined;
  const result: CapabilityModelBindings = {};
  for (const key of ["imageAI", "speechToText", "vision", "textToSpeech"] as const) {
    const ref = cloneModelRef(bindings[key]);
    if (ref) result[key] = ref;
  }
  return Object.keys(result).length ? result : undefined;
}