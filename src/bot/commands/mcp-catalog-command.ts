import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import {
  addMcpCatalogServer,
  completeMcpOAuth,
  configureSecureMcpAuth,
  getMcpAuthSummary,
  loadMcpCatalog,
  resetMcpAuthToAuto,
  resolveMcpRemoteUrl,
  startMcpOAuth,
} from "../../app/services/mcp-catalog-service.js";
import { getCurrentSessionDirectory } from "../../app/services/session-service.js";
import type { McpCredentialRecord } from "../../app/services/mcp-credential-store.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import {
  buildMcpAuthOptionsKeyboard,
  buildMcpCredentialInputKeyboard,
  buildMcpOAuthKeyboard,
  buildMcpsAddTypeKeyboard,
  buildMcpsAddValueKeyboard,
  buildMcpsDetailKeyboard,
  buildMcpsDetailText,
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

export type McpCredentialMode = "bearer" | "api-key" | "custom-header" | "oauth-client";
type McpCredentialStep = "menu" | "header-name" | "secret" | "client-id" | "client-secret" | "scope";

interface PendingMcpCredential {
  serverName: string;
  projectDirectory: string;
  remoteUrl: string;
  messageId: number;
  step: McpCredentialStep;
  mode?: McpCredentialMode;
  headerName?: string;
  clientId?: string;
  clientSecret?: string;
}

const mcpAddWizard = new TopicScopedValue<PendingMcpAdd>();
const mcpAuthWizard = new TopicScopedValue<PendingMcpAuth>();
const mcpCredentialWizard = new TopicScopedValue<PendingMcpCredential>();

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

function isMcpCredentialInteractionActive(): boolean {
  const state = interactionManager.getSnapshot();
  return state?.kind === "custom" && state.metadata.flow === "mcps" && state.metadata.stage === "auth_setup";
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

export async function renderMcpDetailView(
  ctx: Context,
  messageId: number,
  projectDirectory: string,
  serverName: string,
): Promise<void> {
  if (!ctx.chat?.id) return;
  const servers = await loadMcpCatalog(projectDirectory);
  const server = servers.find((item) => item.name === serverName);
  if (!server) {
    await renderMcpList(ctx, messageId, projectDirectory);
    return;
  }

  let authLine = "";
  try {
    const summary = await getMcpAuthSummary(projectDirectory, serverName);
    if (summary) {
      const label =
        summary.mode === "bearer" ? "Bearer Token"
        : summary.mode === "api-key" ? `API Key · ${summary.headerName ?? "X-API-Key"}`
        : summary.mode === "custom-header" ? `Custom Header · ${summary.headerName ?? "Configured"}`
        : "OAuth Client";
      authLine = `\n\n🔐 Authentication: ${label}\nCredentials: securely stored by the bot`;
    }
  } catch {
    authLine = "\n\n⚠️ Stored authentication needs reconfiguration.";
  }

  await ctx.api.editMessageText(
    ctx.chat.id,
    messageId,
    `${buildMcpsDetailText(server)}${authLine}`,
    { reply_markup: buildMcpsDetailKeyboard(server) },
  ).catch((error) => {
    if (!/message is not modified/i.test(error instanceof Error ? error.message : String(error))) throw error;
  });

  interactionManager.start({
    kind: "custom",
    expectedInput: "callback",
    metadata: {
      flow: "mcps",
      stage: "detail",
      messageId,
      projectDirectory,
      serverName,
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

export function isMcpCredentialWizardActive(): boolean {
  return mcpCredentialWizard.isActive();
}

export function clearMcpAddWizard(): void {
  mcpAddWizard.clear();
}

export function clearMcpAuthWizard(): void {
  mcpAuthWizard.clear();
}

export function clearMcpCredentialWizard(): void {
  mcpCredentialWizard.clear();
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

export async function dismissMcpAuthWizard(ctx: Context, restoreDetail = false): Promise<boolean> {
  const pending = mcpAuthWizard.get();
  if (!pending) return false;
  mcpAuthWizard.clear();
  if (isMcpAuthInteractionActive()) interactionManager.clear("mcp_auth_dismissed");
  if (restoreDetail) {
    try {
      await renderMcpDetailView(
        ctx,
        pending.messageId,
        pending.projectDirectory,
        pending.serverName,
      );
    } catch (error) {
      logger.warn("[Mcps] Failed to restore MCP detail after dismissing OAuth:", error);
    }
  }
  return true;
}

export async function dismissMcpCredentialWizard(
  ctx: Context,
  restoreDetail = false,
): Promise<boolean> {
  const pending = mcpCredentialWizard.get();
  if (!pending) return false;
  mcpCredentialWizard.clear();
  if (isMcpCredentialInteractionActive()) interactionManager.clear("mcp_credential_dismissed");
  if (restoreDetail) {
    try {
      await renderMcpDetailView(
        ctx,
        pending.messageId,
        pending.projectDirectory,
        pending.serverName,
      );
    } catch (error) {
      logger.warn("[Mcps] Failed to restore MCP detail after dismissing auth setup:", error);
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


function transitionMcpCredentialWizard(
  pending: PendingMcpCredential,
  expectedInput: "mixed" | "callback",
): void {
  const metadata = {
    flow: "mcps",
    stage: "auth_setup",
    messageId: pending.messageId,
    projectDirectory: pending.projectDirectory,
    serverName: pending.serverName,
    mode: pending.mode,
    step: pending.step,
  };
  if (interactionManager.getSnapshot()) {
    interactionManager.transition({ expectedInput, metadata });
  } else {
    interactionManager.start({ kind: "custom", expectedInput, metadata });
  }
}

function credentialModeLabel(mode: McpCredentialMode): string {
  if (mode === "bearer") return "Bearer Token";
  if (mode === "api-key") return "API Key";
  if (mode === "custom-header") return "Custom Header";
  return "OAuth Client";
}

async function renderMcpCredentialMenu(ctx: Context, pending: PendingMcpCredential): Promise<void> {
  pending.step = "menu";
  pending.mode = undefined;
  pending.headerName = undefined;
  pending.clientId = undefined;
  pending.clientSecret = undefined;
  await renderWizard(
    ctx,
    pending.messageId,
    [
      `🔐 Authentication · ${pending.serverName}`,
      "",
      `Server: ${pending.remoteUrl}`,
      "",
      "Choose how this remote MCP server authenticates.",
      "",
      "✨ Auto / OAuth — recommended when the server supports browser sign-in",
      "🔑 Bearer Token — Authorization: Bearer …",
      "🗝 API Key — X-API-Key by default",
      "🧩 Custom Header — for provider-specific headers",
      "🪪 OAuth Client — pre-registered Client ID / Secret",
      "",
      "Secrets are encrypted by the bot and are never shown to the model.",
    ].join("\n"),
    buildMcpAuthOptionsKeyboard(),
  );
  transitionMcpCredentialWizard(pending, "callback");
}

async function renderMcpCredentialStep(ctx: Context, pending: PendingMcpCredential): Promise<void> {
  const mode = pending.mode;
  if (!mode) {
    await renderMcpCredentialMenu(ctx, pending);
    return;
  }

  let title = `🔐 ${credentialModeLabel(mode)} · ${pending.serverName}`;
  let body = "";
  let keyboard = buildMcpCredentialInputKeyboard();

  if (pending.step === "header-name") {
    body = "Send the HTTP header name used by this MCP server.\n\nExample: X-Service-Token";
  } else if (pending.step === "secret") {
    body = mode === "bearer"
      ? "Send the bearer token.\n\nThe message will be deleted immediately."
      : mode === "api-key"
        ? "Send the API key for X-API-Key.\n\nThe message will be deleted immediately."
        : `Send the value for ${pending.headerName ?? "the custom header"}.\n\nThe message will be deleted immediately.`;
  } else if (pending.step === "client-id") {
    title = `🪪 OAuth Client · ${pending.serverName}`;
    body = "Send the pre-registered OAuth Client ID.";
  } else if (pending.step === "client-secret") {
    title = `🪪 OAuth Client · ${pending.serverName}`;
    body = "Send the Client Secret, or tap Skip Secret if this is a public client.\n\nThe message will be deleted immediately.";
    keyboard = buildMcpCredentialInputKeyboard({ allowSkip: "secret" });
  } else if (pending.step === "scope") {
    title = `🪪 OAuth Client · ${pending.serverName}`;
    body = "Send the OAuth scope requested by the provider, or tap Skip Scope to use the server default.";
    keyboard = buildMcpCredentialInputKeyboard({ allowSkip: "scope" });
  }

  await renderWizard(
    ctx,
    pending.messageId,
    [
      title,
      "",
      `Server: ${pending.remoteUrl}`,
      "",
      body,
      "",
      "🔒 Credentials stay outside model context.",
    ].join("\n"),
    keyboard,
  );
  transitionMcpCredentialWizard(pending, "mixed");
}

export async function startMcpCredentialWizard(ctx: Context, options: {
  serverName: string;
  projectDirectory: string;
  messageId: number;
  preferredMode?: McpCredentialMode;
}): Promise<void> {
  const remoteUrl = await resolveMcpRemoteUrl(options.projectDirectory, options.serverName);
  const pending: PendingMcpCredential = {
    serverName: options.serverName,
    projectDirectory: options.projectDirectory,
    remoteUrl,
    messageId: options.messageId,
    step: "menu",
  };
  mcpCredentialWizard.set(pending);

  if (options.preferredMode) {
    await selectMcpCredentialMode(ctx, options.preferredMode);
    return;
  }
  await renderMcpCredentialMenu(ctx, pending);
}

export async function selectMcpCredentialMode(
  ctx: Context,
  mode: McpCredentialMode,
): Promise<void> {
  const pending = mcpCredentialWizard.get();
  if (!pending) {
    await ctx.answerCallbackQuery({ text: t("inline.inactive_callback"), show_alert: true }).catch(() => {});
    return;
  }

  pending.mode = mode;
  pending.headerName = mode === "api-key" ? "X-API-Key" : undefined;
  pending.clientId = undefined;
  pending.clientSecret = undefined;
  pending.step =
    mode === "custom-header" ? "header-name"
    : mode === "oauth-client" ? "client-id"
    : "secret";
  await ctx.answerCallbackQuery().catch(() => {});
  await renderMcpCredentialStep(ctx, pending);
}

export async function backMcpCredentialWizard(ctx: Context): Promise<boolean> {
  const pending = mcpCredentialWizard.get();
  if (!pending) return false;
  await ctx.answerCallbackQuery().catch(() => {});
  await renderMcpCredentialMenu(ctx, pending);
  return true;
}

async function applyMcpCredential(
  ctx: Context,
  pending: PendingMcpCredential,
  record: McpCredentialRecord,
): Promise<void> {
  try {
    const server = await configureSecureMcpAuth(record);
    mcpCredentialWizard.clear();
    if (isMcpCredentialInteractionActive()) interactionManager.clear("mcp_credential_completed");

    if (record.mode === "oauth-client" && server.status.status === "needs_auth") {
      await startMcpAuthWizard(ctx, {
        serverName: pending.serverName,
        projectDirectory: pending.projectDirectory,
        messageId: pending.messageId,
      });
      return;
    }

    await renderMcpDetailView(
      ctx,
      pending.messageId,
      pending.projectDirectory,
      pending.serverName,
    );
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    logger.warn(
      `[Mcps] Secure auth setup failed: server=${pending.serverName}, mode=${pending.mode ?? "unknown"}, error=${errorName}`,
    );
    await renderWizard(
      ctx,
      pending.messageId,
      [
        `🔐 Authentication · ${pending.serverName}`,
        "",
        "❌ Authentication could not be configured.",
        "Check the credential or provider settings and try again.",
        "",
        "The submitted secret was not displayed or logged.",
      ].join("\n"),
      buildMcpCredentialInputKeyboard(),
    );
    transitionMcpCredentialWizard(pending, "mixed");
  }
}

async function completeOAuthClientCredential(
  ctx: Context,
  pending: PendingMcpCredential,
  scope?: string,
): Promise<void> {
  if (!pending.clientId) {
    pending.step = "client-id";
    await renderMcpCredentialStep(ctx, pending);
    return;
  }
  await applyMcpCredential(ctx, pending, {
    projectDirectory: pending.projectDirectory,
    serverName: pending.serverName,
    remoteUrl: pending.remoteUrl,
    mode: "oauth-client",
    clientId: pending.clientId,
    ...(pending.clientSecret ? { clientSecret: pending.clientSecret } : {}),
    ...(scope?.trim() ? { scope: scope.trim() } : {}),
  });
}

export async function skipMcpCredentialOptionalStep(
  ctx: Context,
  kind: "secret" | "scope",
): Promise<boolean> {
  const pending = mcpCredentialWizard.get();
  if (!pending || pending.mode !== "oauth-client") return false;
  await ctx.answerCallbackQuery().catch(() => {});

  if (kind === "secret" && pending.step === "client-secret") {
    pending.clientSecret = undefined;
    pending.step = "scope";
    await renderMcpCredentialStep(ctx, pending);
    return true;
  }
  if (kind === "scope" && pending.step === "scope") {
    await completeOAuthClientCredential(ctx, pending);
    return true;
  }
  return false;
}

export async function resetMcpCredentialAuthToAuto(ctx: Context): Promise<boolean> {
  const pending = mcpCredentialWizard.get();
  if (!pending) return false;
  await ctx.answerCallbackQuery().catch(() => {});
  try {
    const server = await resetMcpAuthToAuto({
      projectDirectory: pending.projectDirectory,
      serverName: pending.serverName,
      remoteUrl: pending.remoteUrl,
    });
    mcpCredentialWizard.clear();
    if (isMcpCredentialInteractionActive()) interactionManager.clear("mcp_auth_auto");

    if (server.status.status === "needs_auth") {
      await startMcpAuthWizard(ctx, {
        serverName: pending.serverName,
        projectDirectory: pending.projectDirectory,
        messageId: pending.messageId,
      });
      return true;
    }

    await renderMcpDetailView(
      ctx,
      pending.messageId,
      pending.projectDirectory,
      pending.serverName,
    );
    return true;
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    logger.warn(`[Mcps] Failed to reset MCP auth to auto: server=${pending.serverName}, error=${errorName}`);
    await renderMcpCredentialMenu(ctx, pending);
    return true;
  }
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

export async function backMcpAddWizard(ctx: Context): Promise<boolean> {
  const pending = mcpAddWizard.get();
  if (!pending) return false;
  await ctx.answerCallbackQuery().catch(() => {});

  if (pending.step === "value") {
    pending.step = "type";
    pending.type = undefined;
    await renderWizard(
      ctx,
      pending.messageId,
      "➕ Add MCP Server\n\n2/3 · Server type\n\nChoose how OpenCode should connect to this server.",
      buildMcpsAddTypeKeyboard(),
    );
    transitionMcpWizard(pending);
    return true;
  }

  if (pending.step === "type") {
    pending.step = "name";
    pending.name = undefined;
    pending.type = undefined;
    await renderWizard(
      ctx,
      pending.messageId,
      "➕ Add MCP Server\n\n1/3 · Server name\n\nSend a unique name for this MCP server.",
    );
    transitionMcpWizard(pending);
    return true;
  }

  return false;
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
  await renderWizard(ctx, wizard.messageId, prompt, buildMcpsAddValueKeyboard());
  transitionMcpWizard(wizard);
}

export async function handleMcpsMessage(ctx: Context): Promise<boolean> {
  const text = ctx.message?.text?.trim();
  if (!text || !ctx.chat?.id) return false;

  const pendingCredential = mcpCredentialWizard.get();
  if (pendingCredential && isMcpCredentialInteractionActive()) {
    await deleteInput(ctx);

    if (pendingCredential.step === "header-name" && pendingCredential.mode === "custom-header") {
      pendingCredential.headerName = text;
      pendingCredential.step = "secret";
      await renderMcpCredentialStep(ctx, pendingCredential);
      return true;
    }

    if (pendingCredential.step === "client-id" && pendingCredential.mode === "oauth-client") {
      pendingCredential.clientId = text;
      pendingCredential.step = "client-secret";
      await renderMcpCredentialStep(ctx, pendingCredential);
      return true;
    }

    if (pendingCredential.step === "client-secret" && pendingCredential.mode === "oauth-client") {
      pendingCredential.clientSecret = text;
      pendingCredential.step = "scope";
      await renderMcpCredentialStep(ctx, pendingCredential);
      return true;
    }

    if (pendingCredential.step === "scope" && pendingCredential.mode === "oauth-client") {
      await completeOAuthClientCredential(ctx, pendingCredential, text);
      return true;
    }

    if (pendingCredential.step === "secret" && pendingCredential.mode) {
      if (pendingCredential.mode === "bearer") {
        await applyMcpCredential(ctx, pendingCredential, {
          projectDirectory: pendingCredential.projectDirectory,
          serverName: pendingCredential.serverName,
          remoteUrl: pendingCredential.remoteUrl,
          mode: "bearer",
          secret: text,
        });
        return true;
      }

      if (pendingCredential.mode === "api-key" || pendingCredential.mode === "custom-header") {
        const headerName = pendingCredential.headerName ?? (pendingCredential.mode === "api-key" ? "X-API-Key" : "");
        await applyMcpCredential(ctx, pendingCredential, {
          projectDirectory: pendingCredential.projectDirectory,
          serverName: pendingCredential.serverName,
          remoteUrl: pendingCredential.remoteUrl,
          mode: pendingCredential.mode,
          headerName,
          secret: text,
        });
        return true;
      }
    }

    await renderMcpCredentialStep(ctx, pendingCredential);
    return true;
  }

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
      await renderMcpDetailView(
        ctx,
        pendingAuth.messageId,
        pendingAuth.projectDirectory,
        pendingAuth.serverName,
      );
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
      await renderMcpDetailView(
        ctx,
        pendingAuth.messageId,
        pendingAuth.projectDirectory,
        pendingAuth.serverName,
      );
    } catch (error) {
      mcpAuthWizard.clear();
      interactionManager.clear("mcp_auth_failed");
      const errorName = error instanceof Error ? error.name : "UnknownError";
      logger.warn(
        `[Mcps] OAuth completion failed: server=${pendingAuth.serverName}, error=${errorName}`,
      );
      await renderMcpDetailView(
        ctx,
        pendingAuth.messageId,
        pendingAuth.projectDirectory,
        pendingAuth.serverName,
      );
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
      buildMcpsAddValueKeyboard(),
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