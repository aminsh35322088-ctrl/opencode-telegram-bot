import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import { addMcpCatalogServer, loadMcpCatalog } from "../../app/services/mcp-catalog-service.js";
import { getCurrentSessionDirectory } from "../../app/services/session-service.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { buildMcpsAddTypeKeyboard, buildMcpsEmptyKeyboard, buildMcpsListKeyboard } from "../menus/mcp-catalog-menu.js";
import { TopicScopedValue } from "../../app/services/topic-scoped-value.js";

interface PendingMcpAdd { step: "name" | "type" | "value"; name?: string; type?: "local" | "remote"; messageId: number; projectDirectory: string; }
const mcpAddWizard = new TopicScopedValue<PendingMcpAdd>();

function callbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  if (!message || !("message_id" in message)) return null;
  return typeof message.message_id === "number" ? message.message_id : null;
}
function deleteInput(ctx: Context): Promise<unknown> {
  const messageId = ctx.message?.message_id;
  if (!ctx.chat?.id || !messageId) return Promise.resolve();
  return ctx.api.deleteMessage(ctx.chat.id, messageId).catch(() => undefined);
}
async function renderAddWizard(ctx: Context, messageId: number, text: string, keyboard: InlineKeyboard): Promise<void> {
  if (!ctx.chat?.id) return;
  await ctx.api.editMessageText(ctx.chat.id, messageId, text, { reply_markup: keyboard });
}
export function isMcpAddWizardActive(): boolean { return mcpAddWizard.isActive(); }
export function clearMcpAddWizard(): void { mcpAddWizard.clear(); }

export async function startMcpAddWizard(ctx: Context): Promise<void> {
  const projectDirectory = getCurrentSessionDirectory();
  const messageId = callbackMessageId(ctx);
  if (messageId === null) {
    await ctx.answerCallbackQuery({ text: "This menu has expired. Please open MCP Servers again.", show_alert: true }).catch(() => {});
    return;
  }
  mcpAddWizard.set({ step: "name", messageId, projectDirectory });
  await ctx.answerCallbackQuery().catch(() => {});
  await renderAddWizard(ctx, messageId, "➕ Add MCP Server\n\n1/3 · Server name\n\nSend a unique name for this MCP server.", new InlineKeyboard().text("✖ Cancel", "mcps:cancel"));
  interactionManager.start({ kind: "custom", expectedInput: "text", metadata: { flow: "mcps", stage: "add", messageId, projectDirectory } });
}

export async function selectMcpAddType(ctx: Context, type: "local" | "remote"): Promise<void> {
  const wizard = mcpAddWizard.get();
  if (!wizard || wizard.step !== "type") {
    await ctx.answerCallbackQuery({ text: t("inline.inactive_callback"), show_alert: true }).catch(() => {});
    return;
  }
  wizard.type = type;
  wizard.step = "value";
  await ctx.answerCallbackQuery().catch(() => {});
  const prompt = type === "remote"
    ? "➕ Add Remote MCP Server\n\n3/3 · Server URL\n\nSend the absolute MCP Streamable HTTP URL.\n\nExample: https://mcp.example.com/mcp"
    : "➕ Add Local MCP Server\n\n3/3 · Command\n\nSend the command OpenCode should run.\n\nExample: npx -y @modelcontextprotocol/server-everything";
  await renderAddWizard(ctx, wizard.messageId, prompt, new InlineKeyboard().text("✖ Cancel", "mcps:cancel"));
  interactionManager.transition({ expectedInput: "text", metadata: { flow: "mcps", stage: "add", messageId: wizard.messageId, projectDirectory: wizard.projectDirectory, name: wizard.name, type } });
}

export async function handleMcpsMessage(ctx: Context): Promise<boolean> {
  const pending = mcpAddWizard.get();
  const text = ctx.message?.text?.trim();
  if (!pending || !text || !ctx.chat?.id) return false;

  if (pending.step === "name") {
    if (text.length > 128) {
      await renderAddWizard(ctx, pending.messageId, "➕ Add MCP Server\n\n1/3 · Server name\n\n❌ Name must be 128 characters or fewer. Send another name.", new InlineKeyboard().text("✖ Cancel", "mcps:cancel"));
      return true;
    }
    await deleteInput(ctx);
    pending.name = text;
    pending.step = "type";
    await renderAddWizard(ctx, pending.messageId, "➕ Add MCP Server\n\n2/3 · Server type\n\nChoose how OpenCode should connect to this server.", buildMcpsAddTypeKeyboard());
    interactionManager.transition({ expectedInput: "callback", metadata: { flow: "mcps", stage: "add", messageId: pending.messageId, projectDirectory: pending.projectDirectory, name: pending.name } });
    return true;
  }

  if (pending.step !== "value" || !pending.type || !pending.name) return false;
  await deleteInput(ctx);
  try {
    await addMcpCatalogServer({ projectDirectory: pending.projectDirectory, name: pending.name, type: pending.type, value: text });
    const servers = await loadMcpCatalog(pending.projectDirectory);
    mcpAddWizard.clear();
    interactionManager.clear("mcp_add_completed");
    await ctx.api.editMessageText(ctx.chat.id, pending.messageId, t("mcps.select"), { reply_markup: buildMcpsListKeyboard(servers) });
    interactionManager.start({ kind: "custom", expectedInput: "callback", metadata: { flow: "mcps", stage: "list", messageId: pending.messageId, projectDirectory: pending.projectDirectory, servers } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await renderAddWizard(ctx, pending.messageId, `➕ Add MCP Server\n\n3/3 · ${pending.type === "remote" ? "Server URL" : "Command"}\n\n❌ ${message}\n\nSend a corrected value to retry, or press Cancel.`, new InlineKeyboard().text("✖ Cancel", "mcps:cancel"));
  }
  return true;
}

export async function mcpsCommand(ctx: Context): Promise<void> {
  try {
    const projectDirectory = getCurrentSessionDirectory();
    const servers = await loadMcpCatalog(projectDirectory);
    const callbackMessageIdValue = callbackMessageId(ctx);
    let messageId: number;

    if (servers.length === 0) {
      if (callbackMessageIdValue !== null) {
        await startMcpAddWizard(ctx);
        return;
      }
      const text = "🔌 MCP Servers\n\nNo MCP servers are configured for this workspace yet.\n\nAdd one to make external tools available to OpenCode.";
      if (ctx.chat?.id) {
        const message = await ctx.reply(text, { reply_markup: buildMcpsEmptyKeyboard() });
        messageId = message.message_id;
      } else {
        return;
      }
      interactionManager.start({ kind: "custom", expectedInput: "callback", metadata: { flow: "mcps", stage: "list", messageId, projectDirectory, servers } });
      return;
    }

    const keyboard = buildMcpsListKeyboard(servers);
    if (callbackMessageIdValue !== null && ctx.chat?.id) {
      await ctx.api.editMessageText(ctx.chat.id, callbackMessageIdValue, t("mcps.select"), { reply_markup: keyboard });
      await ctx.answerCallbackQuery().catch(() => {});
      messageId = callbackMessageIdValue;
    } else {
      const message = await ctx.reply(t("mcps.select"), { reply_markup: keyboard });
      messageId = message.message_id;
    }

    interactionManager.start({ kind: "custom", expectedInput: "callback", metadata: { flow: "mcps", stage: "list", messageId, projectDirectory, servers } });
  } catch (error) {
    logger.error("[Mcps] Error fetching MCP servers list:", error);
    await ctx.reply(t("mcps.fetch_error"));
  }
}
