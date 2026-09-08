import { Context, InlineKeyboard } from "grammy";
import { fetchCurrentAgent, getAvailableAgents } from "../../app/services/agent-selection-service.js";
import { getAgentDisplayName } from "../../app/types/agent.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { replyWithInlineMenu } from "./inline-menu.js";

/** Build the available agent choices for the current Topic. */
export async function buildAgentSelectionMenu(currentAgent?: string): Promise<InlineKeyboard> {
  const keyboard = new InlineKeyboard();
  const agents = await getAvailableAgents();

  if (agents.length === 0) {
    logger.warn("[AgentHandler] No available agents found");
    return keyboard;
  }

  for (const agent of agents) {
    const isActive = agent.name === currentAgent;
    const label = isActive ? `✅ ${getAgentDisplayName(agent.name)}` : getAgentDisplayName(agent.name);
    keyboard.text(label, `agent:${agent.name}`).row();
  }

  return keyboard;
}

/** Show the agent picker. In a Topic this changes only that Topic's behavior. */
export async function showAgentSelectionMenu(ctx: Context): Promise<void> {
  try {
    const currentAgent = await fetchCurrentAgent();
    const keyboard = await buildAgentSelectionMenu(currentAgent);

    if (keyboard.inline_keyboard.length === 0) {
      await ctx.reply(t("agent.menu.empty"));
      return;
    }

    const text = [
      "🧑‍💻 <b>Agent</b>",
      "",
      currentAgent
        ? `Current: <b>${getAgentDisplayName(currentAgent)}</b>`
        : "Current: <b>Inherited default</b>",
      "",
      "The agent controls the high-level behavior and tool strategy used by this Topic.",
      "Choose an agent below. Your other Topics are not changed.",
    ].join("\n");

    await replyWithInlineMenu(ctx, {
      menuKind: "agent",
      text,
      keyboard,
      parseMode: "HTML",
    });
  } catch (err) {
    logger.error("[AgentHandler] Error showing agent menu:", err);
    await ctx.reply(t("agent.menu.error"));
  }
}
