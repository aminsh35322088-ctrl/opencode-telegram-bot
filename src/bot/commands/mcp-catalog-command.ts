import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import {
  addMcpCatalogServer,
  completeMcpOAuth,
  loadMcpCatalog,
  startMcpOAuth,
} from "../../app/services/mcp-catalog-service.js";
import { getCurrentSessionDirectory } from "../../app/services/session-service.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import {
  buildMcpOAuthKeyboard,
  buildMcpsAddTypeKeyboard,
  buildMcpsEmptyKeyboard,
  buildMcpsListKeyboard,
  buildMcpsWizardKeyboard,
} from "../menus/mcp-catalog-menu.js";
import { TopicScopedValue } from "../../app/services/topic-scoped-value.js";
import { getMainNavigationMessageId } from "../../app/stores/settings-store.js";

interface PendingMcpAdd {
  step: "name" | "type" | "value";
  name?: string;
  type?: "local" | "remote";
  messageId: number;
  projectDirectory: string;
}

interface PendingMcpAuth {
  serverName: string;
  oauthState: string;
  authorizationUrl: string;
  messageId: number;
  projectDirectory: string;
}

const mcpAddWizard = new TopicScopedValue<PendingMcpAdd>();
const mcpAuthWizard = new TopicScopedValue<PendingMcpAuth>();

function callbackMessageId(ctx: Context): number | null {
  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id;
  const canonical = typeof chatId === "number" ? getMainNavigationMessageId(chatId) : undefined;
  if (typeof canonical === "number") return canonical;
  const message = ctx.callbackQuery?.message;
  if (!message || !("message_id" in message)) return null;
  return typeof message.message_id === "number" ? message.message_id : null;
}

function deleteInput(ctx: Context): Promise<unknown> {
  const messageId = ctx.message?.message_id;
  if (!ctx.chat?.id || !messageId) return Promise.resolve();
  return ctx.api.deleteMessage(ctx.chat.id, messageId).catch(() => undefined);
}

async function renderWizard(
  ctx: Context,
  messageId: number,
  text: string,
  keyboard: InlineKeyboard = buildMcpsWizardKeyboard(),
): Promise<void> {
  if (!ctx.chat?.id) return;
  await ctx.api.editMessageText(ctx.chat.id, messageId, text, { reply_markup: keyboard }).catch((error) => {
    if (!/message is not modified/i.test(error instanceof Error ? error.message : String(error))) throw error;
  });
}

function isMcpAddInteractionActive(): boolean {
  const state = interactionManager.getSnapshot();
  return state?.kind === "custom" && state.metadata.flow === "mcps" && state.metadata.stage === "add";
}

function isMcpAuthInteractionActive(): boolean {
  const state = interactionManager.getSnapshot();
  return state?.kind === "custom" && state.metadata.flow === "mcps" && state.metadata.stage === "auth";
}

async function renderMcpList(
  ctx: Context,
  messageId: number,
  projectDirectory: string,
): Promise<void> {
  if (!ctx.chat?.id) return;
  const servers = await loadMcpCatalog(projectDirectory);
  const text = servers.length > 0
    ? t("mcps.select")
    : "🔌 MCP Servers\n\nNo MCP servers are configured for this workspace yet.\n\nAdd one to make external tools available to OpenCode.";
  const keyboard = servers.length > 0 ? buildMcpsListKeyboard(servers) : buildMcpsEmptyKeyboard();
  await ctx.api.editMessageText(ctx.chat.id, messageId, text, { reply_markup: keyboard }).catch((error) => {
    if (!/message is not modified/i.test(error instanceof Error ? error.message : String(error))) throw error;
  });
  interactionManager.start({
    kind: "custom",
    expectedInput: "callback",
    metadata: {
      flow: "mcps",
      stage: "list",
      messageId,
      projectDirectory,
      servers,
    },
  });
}

function transitionMcpWizard(pending: PendingMcpAdd, expectedInput: "mixed" | "callback" = "mixed"): void {
  interactionManager.transition({
    expectedInput,
    metadata: {
      flow: "mcps",
      stage: "add",
      messageId: pending.messageId,
      projectDirectory: pending.projectDirectory,
      name: pending.name,
      type: pending.type,
    },
  });
}

export function isMcpAddWizardActive(): boolean {
  return mcpAddWizard.isActive();
}

export function isMcpAuthWizardActive(): boolean {
  return mcpAuthWizard.isActive();
}

export function clearMcpAddWizard(): void {
  mcpAddWizard.clear();
}

export function clearMcpAuthWizard(): void {
  mcpAuthWizard.clear();
}

export async function dismissMcpAddWizard(ctx: Context, restoreList = false): Promise<boolean> {
  const pending = mcpAddWizard.get();
  if (!pending) return false;
  mcpAddWizard.clear();
  if (isMcpAddInteractionActive()) interactionManager.clear("mcp_add_dismissed");
  if (restoreList) {
    try {
      await renderMcpList(ctx, pending.messageId, pending.projectDirectory);
    } catch (error) {
      logger.warn("[Mcps] Failed to restore MCP list after dismissing add wizard:", error);
    }
  }
  return true;
}

export async function dismissMcpAuthWizard(ctx: Context, restoreList = false): Promise<boolean> {
  const pending = mcpAuthWizard.get();
  if (!pending) return false;
  mcpAuthWizard.clear();
  if (isMcpAuthInteractionActive()) interactionManager.clear("mcp_auth_dismissed");
  if (restoreList) {
    try {
      await renderMcpList(ctx, pending.messageId, pending.projectDirectory);
    } catch (error) {
      logger.warn("[Mcps] Failed to restore MCP list after dismissing OAuth:", error);
    }
  }
  return true;
}

export async function startMcpAuthWizard(ctx: Context, options: {
  serverName: string;
  projectDirectory: string;
  messageId: number;
}): Promise<void> {
  const result = await startMcpOAuth(options.projectDirectory, options.serverName);
  if (!result.authorizationUrl) {
    await renderMcpList(ctx, options.messageId, options.projectDirectory);
    return;
  }

  const pending: PendingMcpAuth = {
    serverName: options.serverName,
    oauthState: result.oauthState,
    authorizationUrl: result.authorizationUrl,
    messageId: options.messageId,
    projectDirectory: options.projectDirectory,
  };
  mcpAuthWizard.set(pending);
  const authMetadata = {
    flow: "mcps",
    stage: "auth",
    messageId: options.messageId,
    projectDirectory: options.projectDirectory,
    serverName: options.serverName,
  };
  if (interactionManager.getSnapshot()) {
    interactionManager.transition({
      expectedInput: "mixed",
      metadata: authMetadata,
    });
  } else {
    interactionManager.start({
      kind: "custom",
      expectedInput: "mixed",
      metadata: authMetadata,
    });
  }

  await renderWizard(
    ctx,
    options.messageId,
    [
      `🔐 Sign in to ${options.serverName}`,
      "",
      "1. Tap Open Login and finish authorization in your browser.",
      "2. If the browser ends on an unavailable localhost page, copy the full URL from the address bar.",
      "3. Send that full callback URL here.",
      "",
      "The authorization code is deleted from Telegram immediately and is never sent to the model.",
    ].join("\n"),
    buildMcpOAuthKeyboard(result.authorizationUrl),
  );
}

export async function startMcpAddWizard(ctx: Context): Promise<void> {
  const projectDirectory = getCurrentSessionDirectory();
  const messageId = callbackMessageId(ctx);
  if (messageId === null || !ctx.chat?.id) {
    await ctx.answerCallbackQuery({ text: "This menu has expired. Please open MCP Servers again.", show_alert: true }).catch(() => {});
    return;
  }

  await dismissMcpAddWizard(ctx);
  await ctx.answerCallbackQuery().catch(() => {});
  const pending: PendingMcpAdd = { step: "name", messageId, projectDirectory };
  mcpAddWizard.set(pending);
  interactionManager.start({
    kind: "custom",
    expectedInput: "mixed",
    metadata: { flow: "mcps", stage: "add", messageId, projectDirectory },
  });
  await renderWizard(
    ctx,
    messageId,
    "➕ Add MCP Server\n\n1/3 · Server name\n\nSend a unique name for this MCP server.",
  );
}

export async function selectMcpAddType(ctx: Context, type: "local" | "remote"): Promise<void> {
  const wizard = mcpAddWizard.get();
  if (!wizard || wizard.step !== "type" || callbackMessageId(ctx) !== wizard.messageId) {
    await ctx.answerCallbackQuery({ text: t("inline.inactive_callback"), show_alert: true }).catch(() => {});
    return;
  }
  wizard.type = type;
  wizard.step = "value";
  await ctx.answerCallbackQuery().catch(() => {});
  const prompt = type === "remote"
    ? "➕ Add Remote MCP Server\n\n3/3 · Server URL\n\nSend the absolute MCP Streamable HTTP URL.\n\nExample: https://mcp.example.com/mcp"
    : "➕ Add Local MCP Server\n\n3/3 · Command\n\nSend the command OpenCode should run.\n\nExample: npx -y @modelcontextprotocol/server-everything";
  await renderWizard(ctx, wizard.messageId, prompt);
  transitionMcpWizard(wizard);
}

export async function handleMcpsMessage(ctx: Context): Promise<boolean> {
  const text = ctx.message?.text?.trim();
  if (!text || !ctx.chat?.id) return false;

  const pendingAuth = mcpAuthWizard.get();
  if (pendingAuth && isMcpAuthInteractionActive()) {
    await deleteInput(ctx);

    let callbackUrl: URL;
    try {
      callbackUrl = new URL(text);
    } catch {
      await renderWizard(
        ctx,
        pendingAuth.messageId,
        "🔐 MCP Login\n\n❌ Send the full callback URL from your browser address bar, including both code and state.",
        buildMcpOAuthKeyboard(pendingAuth.authorizationUrl),
      );
      return true;
    }

    const oauthError = callbackUrl.searchParams.get("error");
    if (oauthError) {
      mcpAuthWizard.clear();
      interactionManager.clear("mcp_auth_provider_error");
      await renderMcpList(ctx, pendingAuth.messageId, pendingAuth.projectDirectory);
      return true;
    }

    const code = callbackUrl.searchParams.get("code");
    const state = callbackUrl.searchParams.get("state");
    if (!code || !state || state !== pendingAuth.oauthState) {
      await renderWizard(
        ctx,
        pendingAuth.messageId,
        "🔐 MCP Login\n\n❌ Invalid OAuth callback. The callback must contain the matching code and state from this login attempt.",
        buildMcpOAuthKeyboard(pendingAuth.authorizationUrl),
      );
      return true;
    }

    try {
      const completed = await completeMcpOAuth(
        pendingAuth.projectDirectory,
        pendingAuth.serverName,
        code,
      );
      mcpAuthWizard.clear();
      interactionManager.clear("mcp_auth_completed");
      if (completed.status.status !== "connected") {
        logger.warn(
          `[Mcps] OAuth completed without connected status: server=${pendingAuth.serverName}, status=${completed.status.status}`,
        );
      }
      await renderMcpList(ctx, pendingAuth.messageId, pendingAuth.projectDirectory);
    } catch (error) {
      mcpAuthWizard.clear();
      interactionManager.clear("mcp_auth_failed");
      logger.warn(`[Mcps] OAuth completion failed for ${pendingAuth.serverName}:`, error);
      await renderMcpList(ctx, pendingAuth.messageId, pendingAuth.projectDirectory);
    }
    return true;
  }

  const pending = mcpAddWizard.get();
  if (!pending || !isMcpAddInteractionActive()) return false;

  await deleteInput(ctx);

  if (pending.step === "name") {
    if (text.length > 128) {
      await renderWizard(
        ctx,
        pending.messageId,
        "➕ Add MCP Server\n\n1/3 · Server name\n\n❌ Name must be 128 characters or fewer. Send another name.",
      );
      transitionMcpWizard(pending);
      return true;
    }
    pending.name = text;
    pending.step = "type";
    await renderWizard(
      ctx,
      pending.messageId,
      "➕ Add MCP Server\n\n2/3 · Server type\n\nChoose how OpenCode should connect to this server.",
      buildMcpsAddTypeKeyboard(),
    );
    transitionMcpWizard(pending);
    return true;
  }

  if (pending.step !== "value" || !pending.type || !pending.name) return false;
  try {
    await addMcpCatalogServer({
      projectDirectory: pending.projectDirectory,
      name: pending.name,
      type: pending.type,
      value: text,
    });
    mcpAddWizard.clear();
    interactionManager.clear("mcp_add_completed");
    await renderMcpList(ctx, pending.messageId, pending.projectDirectory);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await renderWizard(
      ctx,
      pending.messageId,
      `➕ Add MCP Server\n\n3/3 · ${pending.type === "remote" ? "Server URL" : "Command"}\n\n❌ ${message}\n\nSend a corrected value to retry, or go Back.`,
    );
    transitionMcpWizard(pending);
  }
  return true;
}

export async function mcpsCommand(ctx: Context): Promise<void> {
  try {
    const projectDirectory = getCurrentSessionDirectory();
    const servers = await loadMcpCatalog(projectDirectory);
    const callbackMessageIdValue = callbackMessageId(ctx);
    let messageId: number;

    const text = servers.length > 0
      ? t("mcps.select")
      : "🔌 MCP Servers\n\nNo MCP servers are configured for this workspace yet.\n\nAdd one to make external tools available to OpenCode.";
    const keyboard = servers.length > 0 ? buildMcpsListKeyboard(servers) : buildMcpsEmptyKeyboard();

    if (callbackMessageIdValue !== null && ctx.chat?.id) {
      await ctx.api.editMessageText(ctx.chat.id, callbackMessageIdValue, text, { reply_markup: keyboard });
      await ctx.answerCallbackQuery().catch(() => {});
      messageId = callbackMessageIdValue;
    } else if (ctx.chat?.id) {
      const message = await ctx.reply(text, { reply_markup: keyboard });
      messageId = message.message_id;
    } else {
      return;
    }

    interactionManager.start({
      kind: "custom",
      expectedInput: "callback",
      metadata: { flow: "mcps", stage: "list", messageId, projectDirectory, servers },
    });
  } catch (error) {
    logger.error("[Mcps] Error fetching MCP servers list:", error);
    await ctx.reply(t("mcps.fetch_error"));
  }
}