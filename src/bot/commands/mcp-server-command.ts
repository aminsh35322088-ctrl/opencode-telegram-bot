import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import {
  createMcpServerFromInput,
  completeMcpOAuth,
  configureSecureMcpAuth,
  getMcpAuthSummary,
  getMcpLoginIdentity,
  loadMcpServers,
  renameMcpServer,
  resetMcpAuthToAuto,
  resolveMcpRemoteUrl,
  startMcpOAuth,
} from "../../app/services/mcp-server-service.js";
import { getCurrentSessionDirectory } from "../../app/services/session-service.js";
import type { McpCredentialRecord } from "../../app/services/mcp-credential-store.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import {
  buildMcpAuthOptionsKeyboard,
  buildMcpCredentialInputKeyboard,
  buildMcpOAuthKeyboard,
  buildMcpRenameKeyboard,
  buildMcpsAddTypeKeyboard,
  buildMcpsAddValueKeyboard,
  buildMcpsDetailKeyboard,
  buildMcpsDetailText,
  buildMcpsEmptyKeyboard,
  buildMcpsListKeyboard,
  buildMcpsWizardKeyboard,
} from "../menus/mcp-server-menu.js";
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

interface PendingMcpRename {
  serverName: string;
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
const mcpRenameWizard = new TopicScopedValue<PendingMcpRename>();

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

function isMcpRenameInteractionActive(): boolean {
  const state = interactionManager.getSnapshot();
  return state?.kind === "custom" && state.metadata.flow === "mcps" && state.metadata.stage === "rename";
}

async function renderMcpList(
  ctx: Context,
  messageId: number,
  projectDirectory: string,
): Promise<void> {
  if (!ctx.chat?.id) return;
  const servers = await loadMcpServers(projectDirectory);
  const text = servers.length > 0 ? t("mcps.select") : t("mcps.empty");
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
  const servers = await loadMcpServers(projectDirectory);
  const server = servers.find((item) => item.name === serverName);
  if (!server) {
    await renderMcpList(ctx, messageId, projectDirectory);
    return;
  }

  const authLines: string[] = [];
  let summary: Awaited<ReturnType<typeof getMcpAuthSummary>> = null;
  try {
    summary = await getMcpAuthSummary(projectDirectory, serverName);
    if (summary) {
      const modeLabel = credentialModeLabel(summary.mode);
      const label =
        summary.mode === "api-key" || summary.mode === "custom-header"
          ? `${modeLabel} · ${summary.headerName ?? "X-API-Key"}`
          : modeLabel;
      authLines.push(t("mcps.auth.summary", { mode: label }));
    }
  } catch {
    authLines.push(t("mcps.auth.reconfigure"));
  }

  const shouldResolveAccount =
    server.type !== "local" &&
    server.status.status === "connected" &&
    (!summary || summary.mode === "oauth-client");
  if (shouldResolveAccount) {
    try {
      const identity = await getMcpLoginIdentity(projectDirectory, serverName);
      const accountLabel = identity?.email ?? identity?.username ?? identity?.displayName;
      const provider = identity?.providerHost ? ` · ${identity.providerHost}` : "";
      authLines.push(
        accountLabel
          ? t("mcps.auth.account", { identity: accountLabel, provider })
          : t("mcps.auth.account_unknown", { provider }),
      );
    } catch {
      authLines.push(t("mcps.auth.account_unknown", { provider: "" }));
    }
  }

  const authLine = authLines.length > 0 ? `\n\n${authLines.join("\n")}` : "";

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
  const metadata = {
    flow: "mcps",
    stage: "add",
    messageId: pending.messageId,
    projectDirectory: pending.projectDirectory,
    name: pending.name,
    type: pending.type,
  };
  const state = interactionManager.getSnapshot();
  if (state?.kind === "custom" && state.metadata.flow === "mcps") {
    interactionManager.transition({ expectedInput, metadata });
  } else {
    interactionManager.start({ kind: "custom", expectedInput, metadata });
  }
}

function transitionMcpAuthWizard(pending: PendingMcpAuth): void {
  const metadata = {
    flow: "mcps",
    stage: "auth",
    messageId: pending.messageId,
    projectDirectory: pending.projectDirectory,
    serverName: pending.serverName,
  };
  const state = interactionManager.getSnapshot();
  if (state?.kind === "custom" && state.metadata.flow === "mcps") {
    interactionManager.transition({ expectedInput: "mixed", metadata });
  } else {
    interactionManager.start({ kind: "custom", expectedInput: "mixed", metadata });
  }
}

function transitionMcpRenameWizard(pending: PendingMcpRename): void {
  const metadata = {
    flow: "mcps",
    stage: "rename",
    messageId: pending.messageId,
    projectDirectory: pending.projectDirectory,
    serverName: pending.serverName,
  };
  const state = interactionManager.getSnapshot();
  if (state?.kind === "custom" && state.metadata.flow === "mcps") {
    interactionManager.transition({ expectedInput: "mixed", metadata });
  } else {
    interactionManager.start({ kind: "custom", expectedInput: "mixed", metadata });
  }
}

export function isMcpTextWizardActive(): boolean {
  return (
    mcpAddWizard.isActive() ||
    mcpAuthWizard.isActive() ||
    mcpCredentialWizard.isActive() ||
    mcpRenameWizard.isActive()
  );
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

export function clearMcpRenameWizard(): void {
  mcpRenameWizard.clear();
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

export async function dismissMcpRenameWizard(
  ctx: Context,
  restoreDetail = false,
): Promise<boolean> {
  const pending = mcpRenameWizard.get();
  if (!pending) return false;
  mcpRenameWizard.clear();
  if (isMcpRenameInteractionActive()) interactionManager.clear("mcp_rename_dismissed");
  if (restoreDetail) {
    try {
      await renderMcpDetailView(
        ctx,
        pending.messageId,
        pending.projectDirectory,
        pending.serverName,
      );
    } catch (error) {
      logger.warn("[Mcps] Failed to restore MCP detail after dismissing rename:", error);
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
  transitionMcpAuthWizard(pending);

  await renderWizard(
    ctx,
    options.messageId,
    [
      t("mcps.auth.sign_in_title", { name: options.serverName }),
      "",
      t("mcps.auth.sign_in_steps"),
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
  if (mode === "bearer") return t("mcps.auth.mode.bearer");
  if (mode === "api-key") return t("mcps.auth.mode.api_key");
  if (mode === "custom-header") return t("mcps.auth.mode.custom_header");
  return t("mcps.auth.mode.oauth_client");
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
      t("mcps.auth.menu_title", { name: pending.serverName }),
      "",
      t("mcps.auth.server_line", { url: pending.remoteUrl }),
      "",
      t("mcps.auth.menu_prompt"),
      "",
      t("mcps.auth.menu_options"),
      "",
      t("mcps.auth.secrets_note"),
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

  let title = t("mcps.auth.step_title", { mode: credentialModeLabel(mode), name: pending.serverName });
  let body = "";
  let keyboard = buildMcpCredentialInputKeyboard();

  if (pending.step === "header-name") {
    body = t("mcps.auth.header_name_prompt");
  } else if (pending.step === "secret") {
    body = mode === "bearer"
      ? t("mcps.auth.bearer_prompt")
      : mode === "api-key"
        ? t("mcps.auth.api_key_prompt")
        : t("mcps.auth.custom_header_prompt", { header: pending.headerName ?? "the custom header" });
  } else if (pending.step === "client-id") {
    title = t("mcps.auth.step_title_client", { name: pending.serverName });
    body = t("mcps.auth.client_id_prompt");
  } else if (pending.step === "client-secret") {
    title = t("mcps.auth.step_title_client", { name: pending.serverName });
    body = t("mcps.auth.client_secret_prompt");
    keyboard = buildMcpCredentialInputKeyboard({ allowSkip: "secret" });
  } else if (pending.step === "scope") {
    title = t("mcps.auth.step_title_client", { name: pending.serverName });
    body = t("mcps.auth.scope_prompt");
    keyboard = buildMcpCredentialInputKeyboard({ allowSkip: "scope" });
  }

  await renderWizard(
    ctx,
    pending.messageId,
    [
      title,
      "",
      t("mcps.auth.server_line", { url: pending.remoteUrl }),
      "",
      body,
      "",
      t("mcps.auth.outside_context"),
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

  if (pending.mode === "oauth-client") {
    if (pending.step === "scope") {
      pending.step = "client-secret";
      pending.clientSecret = undefined;
      await renderMcpCredentialStep(ctx, pending);
      return true;
    }
    if (pending.step === "client-secret") {
      pending.step = "client-id";
      pending.clientId = undefined;
      pending.clientSecret = undefined;
      await renderMcpCredentialStep(ctx, pending);
      return true;
    }
  }

  if (pending.mode === "custom-header" && pending.step === "secret") {
    pending.step = "header-name";
    pending.headerName = undefined;
    await renderMcpCredentialStep(ctx, pending);
    return true;
  }

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
        t("mcps.auth.menu_title", { name: pending.serverName }),
        "",
        t("mcps.auth.configure_failed"),
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

export async function startMcpRenameWizard(ctx: Context, options: {
  serverName: string;
  projectDirectory: string;
  messageId: number;
}): Promise<void> {
  const pending: PendingMcpRename = {
    serverName: options.serverName,
    projectDirectory: options.projectDirectory,
    messageId: options.messageId,
  };
  mcpRenameWizard.set(pending);
  transitionMcpRenameWizard(pending);
  await renderWizard(
    ctx,
    options.messageId,
    t("mcps.rename.prompt", { name: options.serverName }),
    buildMcpRenameKeyboard(),
  );
}

export async function startMcpAddWizard(ctx: Context): Promise<void> {
  const projectDirectory = getCurrentSessionDirectory();
  const messageId = callbackMessageId(ctx);
  if (messageId === null || !ctx.chat?.id) {
    await ctx.answerCallbackQuery({ text: t("mcps.add.expired"), show_alert: true }).catch(() => {});
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
  await renderWizard(ctx, messageId, t("mcps.add.name_prompt"));
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
      t("mcps.add.type_prompt"),
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
      t("mcps.add.name_prompt"),
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
  const prompt =
    type === "remote" ? t("mcps.add.remote_prompt") : t("mcps.add.local_prompt");
  await renderWizard(ctx, wizard.messageId, prompt, buildMcpsAddValueKeyboard());
  transitionMcpWizard(wizard);
}

export async function handleMcpsMessage(ctx: Context): Promise<boolean> {
  const text = ctx.message?.text?.trim();
  if (!text || !ctx.chat?.id) return false;

  const pendingCredential = mcpCredentialWizard.get();
  if (pendingCredential) {
    if (!isMcpCredentialInteractionActive()) {
      transitionMcpCredentialWizard(
        pendingCredential,
        pendingCredential.step === "menu" ? "callback" : "mixed",
      );
    }
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
  if (pendingAuth) {
    if (!isMcpAuthInteractionActive()) transitionMcpAuthWizard(pendingAuth);
    await deleteInput(ctx);

    let callbackUrl: URL;
    try {
      callbackUrl = new URL(text);
    } catch {
      await renderWizard(
        ctx,
        pendingAuth.messageId,
        t("mcps.auth.invalid_callback_url"),
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
        t("mcps.auth.invalid_callback"),
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

  const pendingRename = mcpRenameWizard.get();
  if (pendingRename) {
    if (!isMcpRenameInteractionActive()) transitionMcpRenameWizard(pendingRename);
    await deleteInput(ctx);
    if (text.length > 128) {
      await renderWizard(
        ctx,
        pendingRename.messageId,
        t("mcps.rename.retry", { error: t("mcps.rename.name_too_long") }),
        buildMcpRenameKeyboard(),
      );
      return true;
    }
    try {
      const renamed = await renameMcpServer(
        pendingRename.projectDirectory,
        pendingRename.serverName,
        text,
      );
      mcpRenameWizard.clear();
      interactionManager.clear("mcp_rename_completed");
      await renderMcpDetailView(
        ctx,
        pendingRename.messageId,
        pendingRename.projectDirectory,
        renamed.name,
      );
    } catch (error) {
      await renderWizard(
        ctx,
        pendingRename.messageId,
        t("mcps.rename.retry", {
          error: error instanceof Error ? error.message : String(error),
        }),
        buildMcpRenameKeyboard(),
      );
      transitionMcpRenameWizard(pendingRename);
    }
    return true;
  }

  const pending = mcpAddWizard.get();
  if (!pending) return false;
  if (!isMcpAddInteractionActive()) transitionMcpWizard(pending);

  await deleteInput(ctx);

  if (pending.step === "name") {
    if (text.length > 128) {
      await renderWizard(
        ctx,
        pending.messageId,
        t("mcps.add.name_too_long"),
      );
      transitionMcpWizard(pending);
      return true;
    }
    pending.name = text;
    pending.step = "type";
    await renderWizard(
      ctx,
      pending.messageId,
      t("mcps.add.type_prompt"),
      buildMcpsAddTypeKeyboard(),
    );
    transitionMcpWizard(pending, "callback");
    return true;
  }

  if (pending.step !== "value" || !pending.type || !pending.name) return false;
  try {
    await createMcpServerFromInput({
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
      t("mcps.add.retry", {
        field:
          pending.type === "remote"
            ? t("mcps.add.field.remote_url")
            : t("mcps.add.field.command"),
        error: message,
      }),
      buildMcpsAddValueKeyboard(),
    );
    transitionMcpWizard(pending);
  }
  return true;
}

export async function mcpsCommand(ctx: Context): Promise<void> {
  try {
    const projectDirectory = getCurrentSessionDirectory();
    const servers = await loadMcpServers(projectDirectory);
    const callbackMessageIdValue = callbackMessageId(ctx);
    let messageId: number;

    const text = servers.length > 0 ? t("mcps.select") : t("mcps.empty");
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