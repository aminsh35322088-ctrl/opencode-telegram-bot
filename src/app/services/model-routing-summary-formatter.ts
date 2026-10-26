import type { ModelInfo } from "../types/model.js";
import type {
  CapabilityRoute,
  ModelRef,
  ModelRoutingCapability,
  UnifiedModelCatalogEntry,
} from "../types/model-capability.js";

function refName(ref: ModelRef | undefined, catalog: UnifiedModelCatalogEntry[]): string {
  if (!ref) return "Not configured";
  const entry = catalog.find((item) => item.providerID === ref.providerID && item.modelID === ref.modelID);
  return entry ? `${entry.modelName} · ${entry.providerName}` : `${ref.modelID} · ${ref.providerID}`;
}

function routeLine(label: string, route: CapabilityRoute | undefined, catalog: UnifiedModelCatalogEntry[]): string {
  if (route?.routeSource === "primary-native") return `✅ ${label} → ${refName(route.model, catalog)} · Primary native`;
  if (route?.routeSource === "topic-override") return `⚙️ ${label} → ${refName(route.model, catalog)} · Topic Override`;
  if (route?.routeSource === "main-default") return `↪️ ${label} → ${refName(route.model, catalog)} · Main Default`;
  return `❌ ${label} → Unavailable`;
}

function capabilityBadge(state: true | false | "unknown" | undefined): string {
  if (state === true) return "✅";
  if (state === false) return "❌";
  return "❔";
}

function modalityList(values: Record<string, true | false | "unknown"> | undefined): string {
  if (!values) return "unconfirmed";
  const supported = Object.entries(values).filter(([, state]) => state === true).map(([name]) => name);
  if (supported.length) return supported.join(", ");
  return Object.values(values).every((state) => state === false) ? "none advertised" : "unconfirmed";
}

export function formatModelRoutingSummary(
  primary: ModelInfo,
  catalog: UnifiedModelCatalogEntry[],
  routes: ReadonlyMap<ModelRoutingCapability, CapabilityRoute>,
): string {
  const ref = { providerID: primary.providerID, modelID: primary.modelID };
  const entry = catalog.find((item) => item.providerID === ref.providerID && item.modelID === ref.modelID);
  const model = refName(ref, catalog);
  const chat = entry?.capabilities.operations.chat;
  const chatLine = chat === true
    ? `✅ Chat / Text → ${model} · Primary native`
    : chat === false
      ? `❌ Chat / Text → ${model} · Not supported`
      : `❔ Chat / Text → ${model} · Capability unconfirmed`;
  const toolCalling = entry?.capabilities.agent.toolCalling;
  const agentMode = chat === false ? "❌" : capabilityBadge(toolCalling);

  return [
    `🧠 Active Model: ${model}`,
    "",
    chatLine,
    routeLine("Vision", routes.get("vision"), catalog),
    `🧠 Reasoning ${capabilityBadge(entry?.capabilities.agent.reasoning)} · Primary model`,
    `📥 Input modalities: ${modalityList(entry?.capabilities.modalities?.input)}`,
    `📤 Output modalities: ${modalityList(entry?.capabilities.modalities?.output)}`,
    routeLine("Voice → Text", routes.get("voiceInput"), catalog),
    routeLine("Image AI", routes.get("imageGenerate"), catalog),
    `🎬 Video AI generation ${capabilityBadge(entry?.capabilities.operations.videoGenerate)} · Primary model metadata`,
    routeLine("Text → Voice", routes.get("textToSpeech"), catalog),
    `🧮 Embeddings ${capabilityBadge(entry?.capabilities.operations.embeddings)}`,
    `🧾 Structured Output ${capabilityBadge(entry?.capabilities.agent.structuredOutput)}`,
    `💻 Coding Optimized ${capabilityBadge(entry?.capabilities.traits?.codingOptimized)}`,
    `🛠️ Tool Calling ${capabilityBadge(toolCalling)} · Primary model`,
    `🤖 Agent Mode ${agentMode}`,
    "",
    "✅ Primary native  ⚙️ Topic Override  ↪️ Main Default  ❌ Unavailable  ❔ Unconfirmed",
  ].join("\n");
}
