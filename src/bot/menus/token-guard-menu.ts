import { InlineKeyboard } from "grammy";
import { fetchCurrentModel } from "../../app/services/model-selection-service.js";
import { getModelContextLimit } from "../../app/services/model-context-limit-service.js";

export const TOKEN_GUARD_MENU_CALLBACK = "tokenguard:menu";
export const TOKEN_GUARD_BACK_CALLBACK = "tokenguard:back";

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

export async function buildTokenGuardMenuView(): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const model = fetchCurrentModel();
  const contextLimit = await getModelContextLimit(model?.providerID, model?.modelID);
  const keyboard = new InlineKeyboard()
    .text("🟢 Auto protection", "tokenguard:auto")
    .row()
    .text("← Back", TOKEN_GUARD_BACK_CALLBACK);

  return {
    text: [
      "🛡️ Token Guard",
      "",
      "Protects requests from unnecessary context growth and runaway usage.",
      "",
      `Current model: ${model?.providerID ?? "unknown"}/${model?.modelID ?? "unknown"}`,
      `Model context limit: ${formatTokens(contextLimit)}`,
      "Mode: Auto",
    ].join("\n"),
    keyboard,
  };
}
