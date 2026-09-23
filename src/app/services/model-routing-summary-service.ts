import type { ModelInfo } from "../types/model.js";
import type { CapabilityRoute, ModelRef, UnifiedModelCatalogEntry } from "../types/model-capability.js";
import { resolveCapabilityPlan } from "./model-capability-routing-service.js";

function refName(ref: ModelRef | undefined, catalog: UnifiedModelCatalogEntry[]): string {
  if (!ref) return "Not configured";
  const entry = catalog.find((item) => item.providerID === ref.providerID && item.modelID === ref.modelID);
  return entry ? `${entry.modelName} · ${entry.providerName}` : `${ref.modelID} · ${ref.providerID}`;
}

function routeBadge(route: CapabilityRoute): string {
  if (route.routeSource === "primary-native") return "✅";
  if (route.routeSource === "topic-override") return "✅ ⚙️";
  if (route.routeSource === "main-default") return "↪️";
  return "❌";
}

function capabilityBadge(state: true | false | "unknown" | undefined): string {
  if (state === true) return "✅";
  if (state === false) return "❌";
  return "❔";
}

export async function buildModelRoutingSummary(primary: ModelInfo, worktree?: string): Promise<string> {
  const plan = await resolveCapabilityPlan(["vision", "voiceInput", "imageGenerate", "textToSpeech"], worktree);
  const { catalog, routes } = plan;
  const vision = routes.get("vision")!;
  const voice = routes.get("voiceInput")!;
  const image = routes.get("imageGenerate")!;
  const tts = routes.get("textToSpeech")!;
  const ref = { providerID: primary.providerID, modelID: primary.modelID };
  const entry = catalog.find((item) => item.providerID === ref.providerID && item.modelID === ref.modelID);
  const chat = capabilityBadge(entry?.capabilities.operations.chat);
  const toolCall = capabilityBadge(entry?.capabilities.agent.toolCalling);
  const agentMode = entry?.capabilities.operations.chat === false
    ? "❌"
    : capabilityBadge(entry?.capabilities.agent.toolCalling);

  return [
    `🧠 ${refName(ref, catalog)}`,
    "",
    `💬 Chat ${chat}`,
    `👁️ Vision ${routeBadge(vision)}`,
    `🎙️ Voice → Text ${routeBadge(voice)}`,
    `🎨 Image AI ${routeBadge(image)}`,
    `🔊 Text → Voice ${routeBadge(tts)}`,
    `🛠️ Tool Call ${toolCall}`,
    `🤖 Agent Mode ${agentMode}`,
  ].join("\n");
}
