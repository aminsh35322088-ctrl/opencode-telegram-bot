import type { ModelInfo } from "../types/model.js";
import type {
  CapabilityRoute,
  ModelRef,
  ModelRoutingCapability,
  UnifiedModelCatalogEntry,
} from "../types/model-capability.js";

function refName(ref: ModelRef | undefined, catalog: UnifiedModelCatalogEntry[]): string {
  if (!ref) return "Not configured";
  const entry = catalog.find(
    (item) => item.providerID === ref.providerID && item.modelID === ref.modelID,
  );
  return entry
    ? `${entry.modelName} · ${entry.providerName}`
    : `${ref.modelID} · ${ref.providerID}`;
}

function routeBadge(route: CapabilityRoute | undefined): string {
  if (route?.routeSource === "primary-native") return "✅";
  if (route?.routeSource === "topic-override") return "✅ ⚙️";
  if (route?.routeSource === "main-default") return "↪️";
  return "❌";
}

function capabilityBadge(state: true | false | "unknown" | undefined): string {
  return state === true ? "✅" : "❌";
}

export function formatModelRoutingSummary(
  primary: ModelInfo,
  catalog: UnifiedModelCatalogEntry[],
  routes: ReadonlyMap<ModelRoutingCapability, CapabilityRoute>,
): string {
  const ref = { providerID: primary.providerID, modelID: primary.modelID };
  const entry = catalog.find(
    (item) => item.providerID === ref.providerID && item.modelID === ref.modelID,
  );
  const chat = capabilityBadge(entry?.capabilities.operations.chat);
  const reasoning = capabilityBadge(entry?.capabilities.agent.reasoning);
  const toolCall = capabilityBadge(entry?.capabilities.agent.toolCalling);
  const agentMode =
    entry?.capabilities.operations.chat === false
      ? "❌"
      : capabilityBadge(entry?.capabilities.agent.toolCalling);

  return [
    `🧠 ${refName(ref, catalog)}`,
    "",
    `💬 Chat ${chat}`,
    `👁️ Vision ${routeBadge(routes.get("vision"))}`,
    `🧠 Reasoning ${reasoning}`,
    `🎙️ Voice → Text ${routeBadge(routes.get("voiceInput"))}`,
    `🎨 Image AI ${routeBadge(routes.get("imageGenerate"))}`,
    `🔊 Text → Voice ${routeBadge(routes.get("textToSpeech"))}`,
    `🛠️ Tool Call ${toolCall}`,
    `🤖 Agent Mode ${agentMode}`,
  ].join("\n");
}
