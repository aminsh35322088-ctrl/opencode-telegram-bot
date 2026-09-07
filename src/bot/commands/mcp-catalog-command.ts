import type { Context } from "grammy";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import { addMcpCatalogServer, loadMcpCatalog } from "../../app/services/mcp-catalog-service.js";
import { getCurrentSessionDirectory } from "../../app/services/session-service.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { buildMcpsAddTypeKeyboard, buildMcpsEmptyKeyboard, buildMcpsListKeyboard } from "../menus/mcp-catalog-menu.js";

interface PendingMcpAdd { step: "name" | "type" | "value"; type?: "local" | "remote"; messageId: number; projectDirectory: string; }
let pendingMcpAdd: PendingMcpAdd | null = null;

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

async function renderAddWizard(ctx: Context, messageId: number, text: string, keyboard = buildMcpsEmptyKeyboard()): Promise<void> {
  if (!ctx.chat?.id) return;
  await ctx.api.editMessageText(ctx.chat.id, messageId, text, { reply_markup: keyboard });
}

export function isMcpAddWizardActive(): boolean { return pendingMcpAdd !== null; }
export function clearMcpAddWizard(): void { pendingMcpAdd = null; }

export async function startMcpAddWizard(ctx: Context): Promise<void> {
  const projectDirectory = getCurrentSessionDirectory();
  const messageId = callbackMessageId(ctx);
  if (messageId === null) {
    await ctx.answerCallbackQuery({ text: "This menu has expired. Please open MCP Servers again.", show_alert: true }).catch(() => {});
    return;
  }
  pendingMcpAdd = { step: "name", messageId, projectDirectory };
  await ctx.answerCallbackQuery().catch(() => {});
  await renderAddWizard(ctx, messageId, "➕ <b>Add MCP Server</b>\n\n1/3 · Server name\n\nSend a unique name for this MCP server.", new (await import("grammy")).InlineKeyboard().text("✖ Cancel", "mcps:cancel"));
  interactionManager.start({ kind: "custom", expectedInput: "text", metadata: { flow: "mcps", stage: "add", messageId, projectDirectory } });
}

export async function selectMcpAddType(ctx: Context, type: "local" | "remote"): Promise<void> {
  if (!pendingMcpAdd || pendingMcpAdd.step !== "type") {
    await ctx.answerCallbackQuery({ text: t("inline.inactive_callback"), show_alert: true }).catch(() => {});
    return;
  }
  pendingMcpAdd.type = type;
  pendingMcpAdd.step = "value";
  await ctx.answerCallbackQuery().catch(() => {});
  const prompt = type === "remote"
    ? "➕ <b>Add Remote MCP Server</b>\n\n3/3 · Server URL\n\nSend the absolute MCP Streamable HTTP URL.\n\nExample: https://mcp.example.com/mcp"
    : "➕ <b>Add Local MCP Server</b>\n\n3/3 · Command\n\nSend the command OpenCode should run.\n\nExample: npx -y @modelcontextprotocol/server-everything";
  await renderAddWizard(ctx, pendingMcpAdd.messageId, prompt, new (await import("grammy")).InlineKeyboard().text("✖ Cancel", "mcps:cancel"));
  interactionManager.transition({ expectedInput: "text", metadata: { flow: "mcps", stage: "add", messageId: pendingMcpAdd.messageId, projectDirectory: pendingMcpAdd.projectDirectory, type } });
}

export async function handleMcpsMessage(ctx: Context): Promise<boolean> {
  const pending = pendingMcpAdd;
  const text = ctx.message?.text?.trim();
  if (!pending || !text || !ctx.chat?.id) return false;

  if (ctx.message?.message_id && pending.step === "name") {
    if (text.length > 128) {
      await renderAddWizard(ctx, pending.messageId, "➕ <b>Add MCP Server</b>\n\n1/3 · Server name\n\n❌ Name must be 128 characters or fewer. Send another name.", new (await import("grammy")).InlineKeyboard().text("✖ Cancel", "mcps:cancel"));
      return true;
    }
    await deleteInput(ctx);
    pending.step = "type";
    pendingMcpAdd = pending;
    await renderAddWizard(ctx, pending.messageId, "➕ <b>Add MCP Server</b>\n\n2/3 · Server type\n\nChoose how OpenCode should connect to this server.", buildMcpsAddTypeKeyboard());
    interactionManager.transition({ expectedInput: "callback", metadata: { flow: "mcps", stage: "add", messageId: pending.messageId, projectDirectory: pending.projectDirectory, name: text } });
    return true;
  }

  if (pending.step !== "value" || !pending.type) return false;
  await deleteInput(ctx);
  try {
    const name = pending.name ?? "";
    await addMcpCatalogServer({ projectDirectory: pending.projectDirectory, name, type: pending.type, value: text });
    const servers = await loadMcpCatalog(pending.projectDirectory);
    pendingMcpAdd = null;
    interactionManager.clear("mcp_add_completed");
    await ctx.api.editMessageText(ctx.chat.id, pending.messageId, t("mcps.select"), { reply_markup: buildMcpsListKeyboard(servers) });
    interactionManager.start({ kind: "custom", expectedInput: "callback", metadata: { flow: "mcps", stage: "list", messageId: pending.messageId, projectDirectory: pending.projectDirectory, servers } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await renderAddWizard(ctx, pending.messageId, `➕ <b>Add MCP Server</b>\n\n3/3 · ${pending.type === "remote" ? "Server URL" : "Command"}\n\n❌ ${message}\n\nSend a corrected value to retry, or press Cancel.`, new (await import("grammy")).InlineKeyboard().text("✖ Cancel", "mcps:cancel"));
  }
  return true;
}

export async function mcpsCommand(ctx: Context): Promise<void> {
  try {
    const projectDirectory = getCurrentSessionDirectory();
    const servers = await loadMcpCatalog(projectDirectory);
    const callbackMessageId = callbackMessageId(ctx);
    let messageId: number;

    if (servers.length === 0) {
      const text = "🔌 <b>MCP Servers</b>\n\nNo MCP servers are configured for this workspace yet. Add one to make external tools available to OpenCode.";
      if (callbackMessageId !== null && ctx.chat?.id) {
        await ctx.api.editMessageText(ctx.chat.id, callbackMessageId, text, { reply_markup: buildMcpsEmptyKeyboard() });
        await ctx.answerCallbackQuery().catch(() => {});
        messageId = callbackMessageId;
      } else {
        const message = await ctx.reply(text, { reply_markup: buildMcpsEmptyKeyboard() });
        messageId = message.message_id;
      }
      interactionManager.start({ kind: "custom", expectedInput: "callback", metadata: { flow: "mcps", stage: "list", messageId, projectDirectory, servers } });
      return;
    }

    const keyboard = buildMcpsListKeyboard(servers);
    if (callbackMessageId !== null && ctx.chat?.id) {
      await ctx.api.editMessageText(ctx.chat.id, callbackMessageId, t("mcps.select"), { reply_markup: keyboard });
      await ctx.answerCallbackQuery().catch(() => {});
      messageId = callbackMessageId;
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
