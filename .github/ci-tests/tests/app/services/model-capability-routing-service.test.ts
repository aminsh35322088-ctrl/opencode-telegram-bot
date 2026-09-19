import { describe, expect, it } from "vitest";
import { resolveCapabilityRouteFromContext } from "../../../src/app/services/model-capability-routing-service.js";
import { detectModelCapabilities } from "../../../src/app/services/model-capability-detection-service.js";
import type { UnifiedModelCatalogEntry } from "../../../src/app/types/model-capability.js";

function entry(providerID: string, modelID: string, metadata: unknown, options: Parameters<typeof detectModelCapabilities>[1] = {}): UnifiedModelCatalogEntry {
  const detected = detectModelCapabilities(metadata, options);
  return { providerID, providerName: providerID, modelID, modelName: modelID, capabilities: detected.capabilities, capabilityDetection: detected.detection, availability: "available" };
}

const catalog = [
  entry("multi", "all", { modalities: { input: ["text", "image", "audio"], output: ["text", "image"] } }),
  entry("text", "chat", { modalities: { input: ["text"], output: ["text"] } }),
  entry("groq", "whisper", { modalities: { input: ["audio"], output: ["text"] } }, { source: "adapter", confidence: "high", forceSpeechToText: true }),
  entry("images", "image", { modalities: { input: ["text", "image"], output: ["image"] } }),
];

describe("capability routing", () => {
  it("uses a capable primary without helpers", () => {
    expect(resolveCapabilityRouteFromContext("imageGenerate", { primary: { providerID: "multi", modelID: "all" }, mainDefaults: { imageAI: { providerID: "images", modelID: "image" } } }, catalog).routeSource).toBe("primary-native");
  });

  it("fills a missing primary capability from the explicit Main Default", () => {
    const route = resolveCapabilityRouteFromContext("imageGenerate", { primary: { providerID: "text", modelID: "chat" }, mainDefaults: { imageAI: { providerID: "images", modelID: "image" } } }, catalog);
    expect(route.routeSource).toBe("main-default");
    expect(route.model).toEqual({ providerID: "images", modelID: "image" });
  });

  it("lets a Topic STT override win even when the primary accepts audio", () => {
    const route = resolveCapabilityRouteFromContext("voiceInput", { primary: { providerID: "multi", modelID: "all" }, topicOverrides: { speechToText: { providerID: "groq", modelID: "whisper" } } }, catalog);
    expect(route.routeSource).toBe("topic-override");
    expect(route.primarySupportsCapability).toBe(true);
    expect(route.model).toEqual({ providerID: "groq", modelID: "whisper" });
  });

  it("never skips an invalid explicit override to silently use another model", () => {
    const route = resolveCapabilityRouteFromContext("voiceInput", { primary: { providerID: "multi", modelID: "all" }, topicOverrides: { speechToText: { providerID: "missing", modelID: "x" } }, mainDefaults: { speechToText: { providerID: "groq", modelID: "whisper" } } }, catalog);
    expect(route.routeSource).toBe("unavailable");
    expect(route.model).toBeUndefined();
  });
});
