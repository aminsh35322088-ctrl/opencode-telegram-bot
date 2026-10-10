import type { ModelInfo } from "../types/model.js";
import type { ModelRoutingCapability } from "../types/model-capability.js";
import { resolveCapabilityPlan } from "./model-capability-routing-service.js";
import { formatModelRoutingSummary } from "./model-routing-summary-formatter.js";

export { formatModelRoutingSummary } from "./model-routing-summary-formatter.js";

export async function buildModelRoutingSummary(primary: ModelInfo, worktree?: string): Promise<string> {
  const capabilities: readonly ModelRoutingCapability[] = [
    "vision",
    "voiceInput",
    "imageGenerate",
    "textToSpeech",
  ];
  const { catalog, routes } = await resolveCapabilityPlan(capabilities, worktree);
  return formatModelRoutingSummary(primary, catalog, routes);
}
