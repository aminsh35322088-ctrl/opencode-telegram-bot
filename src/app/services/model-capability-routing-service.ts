import path from "node:path";
import type {
  CapabilityBindingKey,
  CapabilityModelBindings,
  CapabilityRoute,
  ModelRef,
  ModelRoutingCapability,
  UnifiedModelCatalogEntry,
} from "../types/model-capability.js";
import { cloneCapabilityBindings, cloneModelRef } from "../types/model-capability.js";
import { getCurrentModel, getCurrentTopicSettings, getDefaultCapabilityModel } from "../stores/settings-store.js";
import { readAppState } from "../stores/app-state-store.js";
import { listTopicRuntimeStates } from "../stores/topic-runtime-state-store.js";
import { listUnifiedModelCatalog } from "./unified-model-catalog-service.js";
import { getAiRoleSelection } from "./ai-role-selection-service.js";

interface RoutingContext {
  primary?: ModelRef;
  topicOverrides?: CapabilityModelBindings;
  mainDefaults?: CapabilityModelBindings;
}

function sameDirectory(left: string | undefined, right: string): boolean {
  return Boolean(left) && path.resolve(left!) === path.resolve(right);
}

function bindingKey(capability: ModelRoutingCapability): CapabilityBindingKey {
  if (capability === "imageGenerate" || capability === "imageEdit") return "imageAI";
  if (capability === "voiceInput") return "speechToText";
  return capability;
}

function modelSupportsPrimary(entry: UnifiedModelCatalogEntry | undefined, capability: ModelRoutingCapability): boolean {
  if (!entry) return false;
  switch (capability) {
    case "imageGenerate": return entry.capabilities.operations.imageGenerate === true;
    case "imageEdit": return entry.capabilities.operations.imageEdit === true;
    case "voiceInput": return entry.capabilities.modalities.input.audio === true;
    case "vision": return entry.capabilities.modalities.input.image === true && entry.capabilities.modalities.output.text === true;
    case "textToSpeech": return entry.capabilities.operations.textToSpeech === true;
  }
}

function helperSupports(entry: UnifiedModelCatalogEntry | undefined, capability: ModelRoutingCapability): boolean {
  if (!entry) return false;
  if (capability === "voiceInput") return entry.capabilities.operations.speechToText === true;
  return modelSupportsPrimary(entry, capability);
}

function lookup(catalog: UnifiedModelCatalogEntry[], ref: ModelRef | undefined): UnifiedModelCatalogEntry | undefined {
  if (!ref) return undefined;
  return catalog.find((entry) => entry.providerID === ref.providerID && entry.modelID === ref.modelID && entry.availability === "available");
}

export function resolveCapabilityRouteFromContext(
  capability: ModelRoutingCapability,
  context: RoutingContext,
  catalog: UnifiedModelCatalogEntry[],
): CapabilityRoute {
  const key = bindingKey(capability);
  const override = context.topicOverrides?.[key];
  const primary = context.primary;
  const primarySupported = modelSupportsPrimary(lookup(catalog, primary), capability);

  if (override) {
    if (helperSupports(lookup(catalog, override), capability)) {
      return { capability, model: cloneModelRef(override), routeSource: "topic-override", primarySupportsCapability: primarySupported };
    }
    return { capability, routeSource: "unavailable", primarySupportsCapability: primarySupported, reason: "The configured Topic override is unavailable or does not support this capability." };
  }

  if (primarySupported && primary) {
    return { capability, model: cloneModelRef(primary), routeSource: "primary-native", primarySupportsCapability: true };
  }

  const fallback = context.mainDefaults?.[key];
  if (fallback) {
    if (helperSupports(lookup(catalog, fallback), capability)) {
      return { capability, model: cloneModelRef(fallback), routeSource: "main-default", primarySupportsCapability: false };
    }
    return { capability, routeSource: "unavailable", primarySupportsCapability: false, reason: "The configured Main Default helper is unavailable or does not support this capability." };
  }

  return { capability, routeSource: "unavailable", primarySupportsCapability: false, reason: "No capable model is configured for this operation." };
}

function normalizeBindings(value: unknown): CapabilityModelBindings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as CapabilityModelBindings;
  return cloneCapabilityBindings(raw);
}

async function persistedRoutingContext(worktree: string): Promise<RoutingContext> {
  const [state, topics] = await Promise.all([readAppState(), listTopicRuntimeStates()]);
  const topic = topics.find((candidate) => sameDirectory(candidate.settings.workspaceDirectory, worktree) || sameDirectory(candidate.settings.session?.directory, worktree));
  const settings = state.settings && typeof state.settings === "object" && !Array.isArray(state.settings) ? state.settings as Record<string, unknown> : {};
  let mainDefaults = normalizeBindings(settings.defaultCapabilityModels) ?? {};
  const legacyImage = settings.defaultImageModel;
  if (!mainDefaults.imageAI && legacyImage && typeof legacyImage === "object" && !Array.isArray(legacyImage)) {
    const ref = legacyImage as Partial<ModelRef>;
    if (typeof ref.providerID === "string" && typeof ref.modelID === "string") mainDefaults = { ...mainDefaults, imageAI: { providerID: ref.providerID, modelID: ref.modelID } };
  }
  return {
    primary: topic?.settings.model ? { providerID: topic.settings.model.providerID, modelID: topic.settings.model.modelID } : undefined,
    topicOverrides: cloneCapabilityBindings(topic?.settings.capabilityOverrides) ?? (topic?.settings.imageModelOverride ? { imageAI: { providerID: topic.settings.imageModelOverride.providerID, modelID: topic.settings.imageModelOverride.modelID } } : undefined),
    mainDefaults,
  };
}

function liveRoutingContext(): RoutingContext {
  const topic = getCurrentTopicSettings();
  const current = topic?.model ?? getCurrentModel();
  const mainDefaults: CapabilityModelBindings = {};
  for (const key of ["imageAI", "speechToText", "vision", "textToSpeech"] as const) {
    const model = getDefaultCapabilityModel(key);
    if (model) mainDefaults[key] = model;
  }
  return {
    primary: current?.providerID && current.modelID ? { providerID: current.providerID, modelID: current.modelID } : undefined,
    topicOverrides: cloneCapabilityBindings(topic?.capabilityOverrides) ?? (topic?.imageModelOverride ? { imageAI: { providerID: topic.imageModelOverride.providerID, modelID: topic.imageModelOverride.modelID } } : undefined),
    mainDefaults,
  };
}

export async function resolveCapabilityPlan(capabilities: readonly ModelRoutingCapability[], worktree?: string): Promise<{ routes: Map<ModelRoutingCapability, CapabilityRoute>; catalog: UnifiedModelCatalogEntry[] }> {
  const [context, catalog] = await Promise.all([worktree ? persistedRoutingContext(worktree) : Promise.resolve(liveRoutingContext()), listUnifiedModelCatalog()]);
  if (capabilities.includes("voiceInput") && !context.mainDefaults?.speechToText) {
    const legacyStt = await getAiRoleSelection("stt");
    if (legacyStt) context.mainDefaults = { ...(context.mainDefaults ?? {}), speechToText: legacyStt };
  }
  return { routes: new Map(capabilities.map((capability) => [capability, resolveCapabilityRouteFromContext(capability, context, catalog)])), catalog };
}

export async function resolveCapabilityRoute(capability: ModelRoutingCapability, worktree?: string): Promise<CapabilityRoute> {
  const plan = await resolveCapabilityPlan([capability], worktree);
  return plan.routes.get(capability)!;
}
