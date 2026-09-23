import type { Context } from "grammy";
import type { McpCatalogServerItem } from "../../app/services/mcp-catalog-service.js";
import { loadMcpCatalog, parseMcpCatalogServers, toggleMcpCatalogServer } from "../../app/services/mcp-catalog-service.js";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import type { InteractionState } from "../../app/types/interaction.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { cancelMenu } from "./feedback.js";
import {
  buildMcpsDetailKeyboard,
  buildMcpsDetailText,
  buildMcpsListKeyboard,
  MCPS_CALLBACK_ADD,
  MCPS_CALLBACK_ADD_BACK,
  MCPS_CALLBACK_ADD_LOCAL,
  MCPS_CALLBACK_ADD_REMOTE,
  MCPS_CALLBACK_AUTH_API_KEY,
  MCPS_CALLBACK_AUTH_AUTO,
  MCPS_CALLBACK_AUTH_BACK,
  MCPS_CALLBACK_AUTH_BEARER,
  MCPS_CALLBACK_AUTH_CANCEL,
  MCPS_CALLBACK_AUTH_CLIENT,
  MCPS_CALLBACK_AUTH_CUSTOM_HEADER,
  MCPS_CALLBACK_AUTH_OPTIONS,
  MCPS_CALLBACK_AUTH_SKIP_SCOPE,
  MCPS_CALLBACK_AUTH_SKIP_SECRET,
  MCPS_CALLBACK_AUTH_START,
  MCPS_CALLBACK_BACK,
  MCPS_CALLBACK_CANCEL,
  MCPS_CALLBACK_PREFIX,
  MCPS_CALLBACK_SELECT_PREFIX,
  MCPS_CALLBACK_TOGGLE,
  parseMcpSelectCallback,
} from "../menus/mcp-catalog-menu.js";
import { buildAdvancedSettingsView } from "../menus/settings-menu.js";
import {
  backMcpAddWizard,
  backMcpCredentialWizard,
  startMcpAddWizard,
  startMcpAuthWizard,
  startMcpCredentialWizard,
  selectMcpAddType,
  selectMcpCredentialMode,
  clearMcpAddWizard,
  clearMcpAuthWizard,
  clearMcpCredentialWizard,
  dismissMcpAddWizard,
  dismissMcpAuthWizard,
  dismissMcpCredentialWizard,
  resetMcpCredentialAuthToAuto,
  skipMcpCredentialOptionalStep,
} from "../commands/mcp-catalog-command.js";
import { replyWithInlineMenu } from "../menus/inline-menu.js";
import { getCurrentSessionDirectory } from "../../app/services/session-service.js";

interface McpsListMetadata { flow: "mcps"; stage: "list"; messageId: number; projectDirectory: string; servers: McpCatalogServerItem[]; }
interface McpsDetailMetadata { flow: "mcps"; stage: "detail"; messageId: number; projectDirectory: string; serverName: string; servers: McpCatalogServerItem[]; }
type McpsMetadata = McpsListMetadata | McpsDetailMetadata;

function getCallbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  if (!message || !("message_id" in message)) return null;
  const messageId = (message as { message_id?: number }).message_id;
  return typeof messageId === "number" ? messageId : null;
}

function parseMcpsMetadata(state: InteractionState | null): McpsMetadata | null {
  if (!state || state.kind !== "custom") return null;
  const flow = state.metadata.flow;
  const stage = state.metadata.stage;
  const messageId = state.metadata.messageId;
  const projectDirectory = state.metadata.projectDirectory;
  if (flow !== "mcps" || typeof messageId !== "number" || typeof projectDirectory !== "string") return null;
  const servers = parseMcpCatalogServers(state.metadata.servers);
  if (!servers) return null;
  if (stage === "list") return { flow, stage, messageId, projectDirectory, servers };
  if (stage === "detail") {
    const serverName = state.metadata.serverName;
    if (typeof serverName !== "string" || !serverName.trim()) return null;
    return { flow, stage, messageId, projectDirectory, serverName, servers };
  }
  return null;
}

function clearMcpsInteraction(reason: string): void {
  if (parseMcpsMetadata(interactionManager.getSnapshot())) interactionManager.clear(reason);
}

function isMessageNotModifiedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /message is not modified/i.test(message);
}

async function recoverMcpsListInteraction(ctx: Context): Promise<boolean> {
  const messageId = getCallbackMessageId(ctx);
  if (messageId === null || !ctx.chat?.id) return false;
  const projectDirectory = getCurrentSessionDirectory();
  if (!projectDirectory) return false;
  let servers: McpCatalogServerItem[];
  try {
    servers = await loadMcpCatalog(projectDirectory);
  } catch (error) {
    logger.warn("[Mcps] Failed to recover MCP list interaction:", error);
    return false;
  }
  try {
    await ctx.editMessageText(t("mcps.select"), { reply_markup: buildMcpsListKeyboard(servers) });
  } catch (error) {
    if (!isMessageNotModifiedError(error)) return false;
  }
  interactionManager.start({ kind: "custom", expectedInput: "callback", metadata: { flow: "mcps", stage: "list", messageId, projectDirectory, servers } });
  await ctx.answerCallbackQuery().catch(() => {});
  return true;
}

export async function handleMcpsCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith(MCPS_CALLBACK_PREFIX)) return false;

  if (data === MCPS_CALLBACK_ADD_BACK) {
    if (await backMcpAddWizard(ctx)) return true;
    await ctx.answerCallbackQuery({ text: t("inline.inactive_callback"), show_alert: true }).catch(() => {});
    return true;
  }

  if (data === MCPS_CALLBACK_AUTH_CANCEL) {
    const credentialDismissed = await dismissMcpCredentialWizard(ctx, true);
    if (credentialDismissed) {
      await ctx.answerCallbackQuery({ text: "Authentication setup cancelled." }).catch(() => {});
      return true;
    }

    const oauthDismissed = await dismissMcpAuthWizard(ctx, true);
    if (oauthDismissed) {
      await ctx.answerCallbackQuery({ text: "MCP login cancelled." }).catch(() => {});
      return true;
    }

    clearMcpCredentialWizard();
    clearMcpAuthWizard();
    if (!(await recoverMcpsListInteraction(ctx))) {
      await ctx.answerCallbackQuery({ text: t("inline.inactive_callback"), show_alert: true }).catch(() => {});
    }
    return true;
  }

  if (data === MCPS_CALLBACK_AUTH_BACK) {
    if (await backMcpCredentialWizard(ctx)) return true;
    await ctx.answerCallbackQuery({ text: t("inline.inactive_callback"), show_alert: true }).catch(() => {});
    return true;
  }

  if (data === MCPS_CALLBACK_AUTH_AUTO) {
    if (await resetMcpCredentialAuthToAuto(ctx)) return true;
    await ctx.answerCallbackQuery({ text: t("inline.inactive_callback"), show_alert: true }).catch(() => {});
    return true;
  }

  if (data === MCPS_CALLBACK_AUTH_SKIP_SECRET) {
    if (await skipMcpCredentialOptionalStep(ctx, "secret")) return true;
    await ctx.answerCallbackQuery({ text: t("inline.inactive_callback"), show_alert: true }).catch(() => {});
    return true;
  }

  if (data === MCPS_CALLBACK_AUTH_SKIP_SCOPE) {
    if (await skipMcpCredentialOptionalStep(ctx, "scope")) return true;
    await ctx.answerCallbackQuery({ text: t("inline.inactive_callback"), show_alert: true }).catch(() => {});
    return true;
  }

  const credentialModeByCallback = new Map([
    [MCPS_CALLBACK_AUTH_BEARER, "bearer"],
    [MCPS_CALLBACK_AUTH_API_KEY, "api-key"],
    [MCPS_CALLBACK_AUTH_CUSTOM_HEADER, "custom-header"],
    [MCPS_CALLBACK_AUTH_CLIENT, "oauth-client"],
  ] as const);
  const credentialMode = credentialModeByCallback.get(data as never);
  if (credentialMode) {
    const state = interactionManager.getSnapshot();
    if (state?.kind === "custom" && state.metadata.flow === "mcps" && state.metadata.stage === "auth_setup") {
      await selectMcpCredentialMode(ctx, credentialMode);
      return true;
    }
  }

  if (data === MCPS_CALLBACK_CANCEL) {
    const dismissed = await dismissMcpAddWizard(ctx, true);
    if (!dismissed) {
      clearMcpAddWizard();
      interactionManager.clear("mcps_cancelled");
      await ctx.answerCallbackQuery().catch(() => {});
      await cancelMenu(ctx);
      return true;
    }
    await ctx.answerCallbackQuery({ text: "MCP setup cancelled." }).catch(() => {});
    return true;
  }

  if (data === "mcps:parent_back") {
    await dismissMcpAddWizard(ctx);
    clearMcpAddWizard();
    await ctx.answerCallbackQuery().catch(() => {});
    const view = buildAdvancedSettingsView();
    await replyWithInlineMenu(ctx, { menuKind: "settings", text: view.text, keyboard: view.keyboard });
    return true;
  }

  if (data === MCPS_CALLBACK_ADD_LOCAL || data === MCPS_CALLBACK_ADD_REMOTE) {
    await selectMcpAddType(ctx, data === MCPS_CALLBACK_ADD_LOCAL ? "local" : "remote");
    return true;
  }

  let metadata = parseMcpsMetadata(interactionManager.getSnapshot());
  const callbackMessageId = getCallbackMessageId(ctx);
  if (!metadata || callbackMessageId === null || metadata.messageId !== callbackMessageId) {
    if (!(await recoverMcpsListInteraction(ctx))) {
      await ctx.answerCallbackQuery({ text: t("inline.inactive_callback"), show_alert: true });
      return true;
    }
    metadata = parseMcpsMetadata(interactionManager.getSnapshot());
    if (!metadata || callbackMessageId === null || metadata.messageId !== callbackMessageId) {
      await ctx.answerCallbackQuery({ text: t("inline.inactive_callback"), show_alert: true });
      return true;
    }
  }

  if (data === MCPS_CALLBACK_ADD) {
    if (metadata.stage !== "list" || callbackMessageId === null || metadata.messageId !== callbackMessageId) {
      await ctx.answerCallbackQuery({ text: t("inline.inactive_callback"), show_alert: true });
      return true;
    }
    await startMcpAddWizard(ctx);
    return true;
  }

  try {
    if (data === MCPS_CALLBACK_BACK) {
      if (metadata.stage !== "detail") {
        await ctx.answerCallbackQuery({ text: t("callback.processing_error") });
        return true;
      }
      const servers = await loadMcpCatalog(metadata.projectDirectory);
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(t("mcps.select"), { reply_markup: buildMcpsListKeyboard(servers) });
      interactionManager.transition({ expectedInput: "callback", metadata: { flow: "mcps", stage: "list", messageId: metadata.messageId, projectDirectory: metadata.projectDirectory, servers } });
      return true;
    }

    if (data === MCPS_CALLBACK_AUTH_OPTIONS) {
      if (metadata.stage !== "detail") {
        await ctx.answerCallbackQuery({ text: t("callback.processing_error") });
        return true;
      }
      await ctx.answerCallbackQuery().catch(() => {});
      await startMcpCredentialWizard(ctx, {
        serverName: metadata.serverName,
        projectDirectory: metadata.projectDirectory,
        messageId: metadata.messageId,
      });
      return true;
    }

    if (data === MCPS_CALLBACK_AUTH_CLIENT) {
      if (metadata.stage !== "detail") {
        await ctx.answerCallbackQuery({ text: t("callback.processing_error") });
        return true;
      }
      await ctx.answerCallbackQuery().catch(() => {});
      await startMcpCredentialWizard(ctx, {
        serverName: metadata.serverName,
        projectDirectory: metadata.projectDirectory,
        messageId: metadata.messageId,
        preferredMode: "oauth-client",
      });
      return true;
    }

    if (data === MCPS_CALLBACK_AUTH_START) {
      if (metadata.stage !== "detail") {
        await ctx.answerCallbackQuery({ text: t("callback.processing_error") });
        return true;
      }
      const server = metadata.servers.find((item) => item.name === metadata.serverName);
      if (!server || server.status.status !== "needs_auth") {
        await ctx.answerCallbackQuery({ text: "This MCP server is not waiting for OAuth login.", show_alert: true });
        return true;
      }
      await ctx.answerCallbackQuery({ text: "Opening secure MCP login…" }).catch(() => {});
      await startMcpAuthWizard(ctx, {
        serverName: metadata.serverName,
        projectDirectory: metadata.projectDirectory,
        messageId: metadata.messageId,
      });
      return true;
    }

    if (data === MCPS_CALLBACK_TOGGLE) {
      if (metadata.stage !== "detail") {
        await ctx.answerCallbackQuery({ text: t("callback.processing_error") });
        return true;
      }
      const server = metadata.servers.find((item) => item.name === metadata.serverName);
      if (!server) {
        await ctx.answerCallbackQuery({ text: t("inline.inactive_callback"), show_alert: true });
        return true;
      }
      const enable = server.status.status !== "connected";
      await ctx.answerCallbackQuery({ text: enable ? t("mcps.enabling") : t("mcps.disabling") });
      await toggleMcpCatalogServer(metadata.projectDirectory, metadata.serverName, enable);
      const updatedServers = await loadMcpCatalog(metadata.projectDirectory);
      const updatedServer = updatedServers.find((item) => item.name === metadata.serverName);
      if (!updatedServer) {
        await ctx.editMessageText(t("mcps.select"), { reply_markup: buildMcpsListKeyboard(updatedServers) });
        interactionManager.transition({ expectedInput: "callback", metadata: { flow: "mcps", stage: "list", messageId: metadata.messageId, projectDirectory: metadata.projectDirectory, servers: updatedServers } });
        return true;
      }
      await ctx.editMessageText(buildMcpsDetailText(updatedServer), { reply_markup: buildMcpsDetailKeyboard(updatedServer) });
      interactionManager.transition({ expectedInput: "callback", metadata: { flow: "mcps", stage: "detail", messageId: metadata.messageId, projectDirectory: metadata.projectDirectory, serverName: updatedServer.name, servers: updatedServers } });
      return true;
    }

    if (data.startsWith(MCPS_CALLBACK_SELECT_PREFIX)) {
      if (metadata.stage !== "list") {
        await ctx.answerCallbackQuery({ text: t("callback.processing_error") });
        return true;
      }
      const serverIndex = parseMcpSelectCallback(data);
      const server = serverIndex === null ? undefined : metadata.servers[serverIndex];
      if (!server) {
        await ctx.answerCallbackQuery({ text: t("inline.inactive_callback"), show_alert: true });
        return true;
      }
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(buildMcpsDetailText(server), { reply_markup: buildMcpsDetailKeyboard(server) });
      interactionManager.transition({ expectedInput: "callback", metadata: { flow: "mcps", stage: "detail", messageId: metadata.messageId, projectDirectory: metadata.projectDirectory, serverName: server.name, servers: metadata.servers } });
      return true;
    }

    await ctx.answerCallbackQuery({ text: t("callback.unknown_command") });
    return true;
  } catch (error) {
    logger.error("[Mcps] Error handling MCP callback:", error);
    clearMcpsInteraction("mcps_callback_error");
    clearMcpAddWizard();
    clearMcpAuthWizard();
    clearMcpCredentialWizard();
    await ctx.answerCallbackQuery({ text: t("mcps.toggle_error") }).catch(() => {});
    return true;
  }
}
