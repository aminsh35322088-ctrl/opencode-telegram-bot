import type { ModelInfo } from "../types/model.js";
import type { CapabilityRoute, ModelRef, UnifiedModelCatalogEntry } from "../types/model-capability.js";
import { resolveCapabilityPlan } from "./model-capability-routing-service.js";

function refName(ref: ModelRef | undefined, catalog: UnifiedModelCatalogEntry[]): string {
  if (!ref) return "Not configured";
  const entry = catalog.find((item) => item.providerID === ref.providerID && item.modelID === ref.modelID);
  return entry ? `${entry.modelName} · ${entry.providerName}` : `${ref.modelID} · ${ref.providerID}`;
}

function routeLine(label: string, route: CapabilityRoute, catalog: UnifiedModelCatalogEntry[]): string {
  if (route.routeSource === "primary-native") return `✅ ${label} → ${refName(route.model, catalog)} · Native`;
  if (route.routeSource === "topic-override") return `⚙️ ${label} → ${refName(route.model, catalog)} · Topic Override`;
  if (route.routeSource === "main-default") return `↪️ ${label} → ${refName(route.model, catalog)} · Main Default`;
  return `❌ ${label} → Unavailable`;
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
  const chat = entry?.capabilities.operations.chat === true
    ? `✅ Chat / Text → ${refName(ref, catalog)} · Native`
    : `❌ Chat / Text → ${refName(ref, catalog)} · capability unconfirmed`;

  return [
    `🧠 Active Model: ${refName(ref, catalog)}`,
    "",
    chat,
    routeLine("Vision", vision, catalog),
    routeLine("Voice → Text", voice, catalog),
    routeLine("Image AI", image, catalog),
    routeLine("Text → Voice", tts, catalog),
    "",
    "✅ Native  ⚙️ Topic Override  ↪️ Main Default  ❌ Unavailable",
  ].join("\n");
}
