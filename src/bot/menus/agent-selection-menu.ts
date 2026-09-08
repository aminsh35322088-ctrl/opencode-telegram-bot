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
    const label = isActive
      ? `✅ ${getAgentDisplayName(agent.name)}`
      : getAgentDisplayName(agent.name);
    keyboard.text(label, `agent:${agent.name}`).row();
  }

  return keyboard;
}

function isTopicContext(ctx: Context): boolean {
  const message = ctx.message ?? ctx.callbackQuery?.message;
  const threadId =
    message && "message_thread_id" in message
      ? (message as { message_thread_id?: number }).message_thread_id
      : undefined;
  return typeof threadId === "number" && threadId > 1;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Show the agent picker with the live agent description from OpenCode. */
export async function showAgentSelectionMenu(ctx: Context): Promise<void> {
  try {
    const [currentAgent, agents] = await Promise.all([fetchCurrentAgent(), getAvailableAgents()]);
    const keyboard = await buildAgentSelectionMenu(currentAgent);

    if (keyboard.inline_keyboard.length === 0) {
      await ctx.reply(t("agent.menu.empty"));
      return;
    }

    const activeAgent = agents.find((agent) => agent.name === currentAgent);
    const detailLines = activeAgent
      ? [
          `Current: <b>${escapeHtml(getAgentDisplayName(activeAgent.name))}</b>`,
          activeAgent.description
            ? `Description: ${escapeHtml(activeAgent.description)}`
            : "Description: OpenCode did not provide a description for this agent.",
          `Mode: <b>${escapeHtml(activeAgent.mode)}</b>`,
          typeof activeAgent.steps === "number"
            ? `Steps: <b>${activeAgent.steps}</b>`
            : "Steps: <b>Unspecified</b>",
        ]
      : ["Current: <b>Inherited default</b>"];

    const text = [
      "🧑‍💻 <b>Agent</b>",
      "",
      ...detailLines,
      "",
      "The agent controls the high-level behavior used by this Topic. Its description, mode and step limit come directly from OpenCode.",
      "Choose an agent below. Your other Topics are not changed.",
    ].join("\n");

    await replyWithInlineMenu(ctx, {
      menuKind: "agent",
      text,
      keyboard,
      parseMode: "HTML",
      navigation: isTopicContext(ctx) ? "both" : "auto",
    });
  } catch (err) {
    logger.error("[AgentHandler] Error showing agent menu:", err);
    await ctx.reply(t("agent.menu.error"));
  }
}
