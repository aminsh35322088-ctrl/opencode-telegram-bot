import type { McpLocalConfig, McpRemoteConfig, McpStatus } from "@opencode-ai/sdk/v2";
import { opencodeClient } from "../../opencode/client.js";
import { logger } from "../../utils/logger.js";
import { isRecord } from "../../utils/type-guards.js";
import {
  listMcpCredentials,
  loadMcpCredential,
  removeMcpCredential,
  saveMcpCredential,
  type McpCredentialRecord,
} from "./mcp-credential-store.js";
import {
  listManagedMcpServers,
  loadManagedMcpServer,
  saveManagedMcpServer,
  type ManagedMcpConfig,
  type ManagedMcpServer,
} from "./mcp-server-store.js";

export type McpServerType = "local" | "remote" | "unknown";
export interface McpServerItem { name: string; status: McpStatus; type: McpServerType; }
export interface McpOAuthStartResult { authorizationUrl: string; oauthState: string; }
function normalizeDirectoryForMcpApi(directory: string): string { return directory.replace(/\\/g, "/"); }
const MCP_STATUS_NAMES = ["connected", "disabled", "failed", "needs_auth", "needs_client_registration"] as const;
function isMcpStatusName(value: unknown): value is (typeof MCP_STATUS_NAMES)[number] { return typeof value === "string" && MCP_STATUS_NAMES.some((name) => name === value); }
function buildMcpStatus(statusValue: (typeof MCP_STATUS_NAMES)[number], errorValue: unknown): McpStatus { if (statusValue === "failed" || statusValue === "needs_client_registration") return { status: statusValue, error: typeof errorValue === "string" ? errorValue : "" }; return { status: statusValue }; }
type ParsedMcpServerStatus = { kind: "ok"; status: McpStatus } | { kind: "skip" } | { kind: "invalid" };
function parseMcpServerStatus(status: unknown): ParsedMcpServerStatus {
  if (!isRecord(status)) return { kind: "invalid" };
  if (!isMcpStatusName(status.status)) { if (typeof status.status === "string") { logger.debug(`[McpServer] Unknown MCP status "${status.status}", skipping server`); return { kind: "skip" }; } return { kind: "invalid" }; }
  return { kind: "ok", status: buildMcpStatus(status.status, status.error) };
}
export function parseMcpServerItems(value: unknown): McpServerItem[] | null {
  if (!isRecord(value)) return null;
  if (Array.isArray(value)) {
    const servers: McpServerItem[] = [];
    for (const item of value) {
      if (!isRecord(item) || typeof item.name !== "string") return null;
      const parsed = parseMcpServerStatus(item.status);
      if (parsed.kind === "invalid") return null;
      if (parsed.kind === "skip") continue;
      const type: McpServerType =
        item.type === "local" || item.type === "remote" ? item.type : "unknown";
      servers.push({ name: item.name, status: parsed.status, type });
    }
    return servers;
  }
  const servers: McpServerItem[] = [];
  for (const [name, statusValue] of Object.entries(value)) {
    const parsed = parseMcpServerStatus(statusValue);
    if (parsed.kind === "invalid") return null;
    if (parsed.kind === "skip") continue;
    servers.push({ name, status: parsed.status, type: "unknown" });
  }
  return servers;
}

function configTypeIndex(value: unknown): Map<string, McpServerType> {
  const result = new Map<string, McpServerType>();
  if (!isRecord(value) || !isRecord(value.mcp)) return result;
  const mcp = value.mcp;
  const nested = isRecord(mcp.servers) ? mcp.servers : null;
  for (const source of [mcp, nested]) {
    if (!source) continue;
    for (const [name, candidate] of Object.entries(source)) {
      if (name === "servers" || !isRecord(candidate)) continue;
      if (candidate.type === "local" || candidate.type === "remote") {
        result.set(name, candidate.type);
      }
    }
  }
  return result;
}

async function loadConfiguredTypeIndex(projectDirectory: string): Promise<Map<string, McpServerType>> {
  const index = new Map<string, McpServerType>();
  try {
    const managed = await listManagedMcpServers(projectDirectory);
    for (const server of managed) index.set(server.name, server.config.type);
  } catch (error) {
    logger.warn("[McpServer] Failed to read managed MCP definitions:", error);
  }
  try {
    const { data, error } = await opencodeClient.config.get({
      directory: normalizeDirectoryForMcpApi(projectDirectory),
    });
    if (!error && data) {
      for (const [name, type] of configTypeIndex(data as unknown)) {
        if (!index.has(name)) index.set(name, type);
      }
    }
  } catch (error) {
    logger.debug("[McpServer] OpenCode config unavailable while enriching MCP status", error);
  }
  return index;
}

export async function loadMcpServers(projectDirectory: string): Promise<McpServerItem[]> {
  const { data, error } = await opencodeClient.mcp.status({
    directory: normalizeDirectoryForMcpApi(projectDirectory),
  });
  if (error || !data) throw error || new Error("No MCP status data received");
  const servers = parseMcpServerItems(data);
  if (!servers) throw new Error("Invalid MCP status data format");
  const typeIndex = await loadConfiguredTypeIndex(projectDirectory);
  return servers.map((server) => ({
    ...server,
    type: typeIndex.get(server.name) ?? server.type,
  }));
}

export type McpAuthSummary = {
  configured: true;
  mode: McpCredentialRecord["mode"];
  headerName?: string;
};

const HTTP_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

function assertSafeHeaderName(value: string): string {
  const name = value.trim();
  if (!name || !HTTP_HEADER_NAME.test(name)) {
    throw new Error("MCP authentication header name is invalid.");
  }
  return name;
}

function assertSafeHeaderValue(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("MCP authentication header value is required.");
  if (/[\r\n]/u.test(normalized)) {
    throw new Error("MCP authentication header value must not contain CR or LF.");
  }
  return normalized;
}

function assertSecureRemoteUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MCP remote URL must be an absolute HTTP(S) URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("MCP remote URL must be an absolute HTTP(S) URL.");
  }
  return value.trim();
}

function buildSecureMcpConfig(record: McpCredentialRecord): McpRemoteConfig {
  const url = assertSecureRemoteUrl(record.remoteUrl);

  if (record.mode === "bearer") {
    return {
      type: "remote",
      url,
      oauth: false,
      headers: { Authorization: `Bearer ${assertSafeHeaderValue(record.secret)}` },
    };
  }

  if (record.mode === "api-key" || record.mode === "custom-header") {
    return {
      type: "remote",
      url,
      oauth: false,
      headers: {
        [assertSafeHeaderName(record.headerName)]: assertSafeHeaderValue(record.secret),
      },
    };
  }

  const clientId = record.clientId.trim();
  if (!clientId) throw new Error("MCP OAuth client ID is required.");
  const clientSecret = record.clientSecret?.trim();
  const scope = record.scope?.trim();
  return {
    type: "remote",
    url,
    oauth: {
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      ...(scope ? { scope } : {}),
    },
  };
}

async function addSecureMcpDefinition(
  record: McpCredentialRecord,
  config: McpRemoteConfig = buildSecureMcpConfig(record),
): Promise<McpServerItem> {
  const name = record.serverName.trim();
  if (!name) throw new Error("MCP server name is required.");
  const { data, error } = await opencodeClient.mcp.add({
    directory: normalizeDirectoryForMcpApi(record.projectDirectory),
    name,
    config,
  });
  if (error || !data) {
    throw new Error(`OpenCode could not configure secure MCP server "${name}".`);
  }
  const parsed = parseMcpServerItems(data);
  const server = parsed?.find((item) => item.name === name);
  if (!server) throw new Error(`OpenCode returned an invalid status for MCP server "${name}".`);
  return { ...server, type: "remote" };
}

async function scrubSecureMcpDefinition(record: McpCredentialRecord): Promise<void> {
  const name = record.serverName.trim();
  if (!name) return;
  try {
    await opencodeClient.mcp.add({
      directory: normalizeDirectoryForMcpApi(record.projectDirectory),
      name,
      config: {
        type: "remote",
        url: assertSecureRemoteUrl(record.remoteUrl),
      },
    });
  } catch {
    // Best-effort secret scrubbing must never mask the original auth/storage failure.
  }
}

function assertAcceptedSecureMcpStatus(
  record: McpCredentialRecord,
  server: McpServerItem,
): void {
  if (record.mode === "oauth-client") {
    if (server.status.status === "connected" || server.status.status === "needs_auth") return;
    if (server.status.status === "needs_client_registration") {
      throw new Error("MCP OAuth client registration was not accepted.");
    }
    throw new Error("MCP OAuth client did not connect.");
  }

  if (server.status.status !== "connected") {
    throw new Error("MCP credential did not authenticate.");
  }
}

export async function configureSecureMcpAuth(
  record: McpCredentialRecord,
): Promise<McpServerItem> {
  const secureConfig = buildSecureMcpConfig(record);
  try {
    const server = await addSecureMcpDefinition(record, secureConfig);
    assertAcceptedSecureMcpStatus(record, server);
    await saveManagedMcpServer({
      projectDirectory: record.projectDirectory,
      name: record.serverName,
      config: { type: "remote", url: record.remoteUrl },
    });
    await saveMcpCredential(record);
    return server;
  } catch (error) {
    await scrubSecureMcpDefinition(record);
    throw error;
  }
}

export async function restoreSecureMcpConnections(): Promise<{ restored: number; failed: number }> {
  let records: McpCredentialRecord[];
  try {
    records = await listMcpCredentials();
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    logger.warn(`[McpServer] Secure MCP credentials could not be opened (error=${errorName})`);
    return { restored: 0, failed: 1 };
  }

  let restored = 0;
  let failed = 0;
  for (const record of records) {
    try {
      const server = await addSecureMcpDefinition(record);
      assertAcceptedSecureMcpStatus(record, server);
      restored += 1;
    } catch (error) {
      await scrubSecureMcpDefinition(record);
      failed += 1;
      const errorName = error instanceof Error ? error.name : "UnknownError";
      logger.warn(
        `[McpServer] Failed to restore secure MCP "${record.serverName}" (error=${errorName})`,
      );
    }
  }
  return { restored, failed };
}

export async function getMcpAuthSummary(
  projectDirectory: string,
  serverName: string,
): Promise<McpAuthSummary | null> {
  const record = await loadMcpCredential(projectDirectory, serverName);
  if (!record) return null;
  if (record.mode === "api-key" || record.mode === "custom-header") {
    return { configured: true, mode: record.mode, headerName: record.headerName };
  }
  return { configured: true, mode: record.mode };
}

export async function resolveMcpRemoteUrl(
  projectDirectory: string,
  serverName: string,
): Promise<string> {
  try {
    const stored = await loadMcpCredential(projectDirectory, serverName);
    if (stored) return assertSecureRemoteUrl(stored.remoteUrl);
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    logger.warn(
      `[McpServer] Stored auth could not be opened while resolving MCP URL for "${serverName}" (error=${errorName})`,
    );
  }

  try {
    const managed = await loadManagedMcpServer(projectDirectory, serverName);
    if (managed?.config.type === "remote") return assertSecureRemoteUrl(managed.config.url);
  } catch (error) {
    logger.debug(
      `[McpServer] Managed definition unavailable while resolving "${serverName}"`,
      error,
    );
  }

  const directory = normalizeDirectoryForMcpApi(projectDirectory);
  const { data, error } = await opencodeClient.config.get({ directory });
  if (error || !data) {
    throw new Error(`OpenCode config is unavailable for MCP server "${serverName}".`);
  }

  const configValue = data as unknown;
  if (!isRecord(configValue) || !isRecord(configValue.mcp)) {
    throw new Error(`MCP server "${serverName}" is not a configured remote server.`);
  }

  const mcpConfig = configValue.mcp;
  const direct = mcpConfig[serverName];
  const nestedServers = isRecord(mcpConfig.servers) ? mcpConfig.servers : null;
  const nested = nestedServers?.[serverName];

  for (const candidate of [direct, nested]) {
    if (!isRecord(candidate) || candidate.type !== "remote" || typeof candidate.url !== "string") {
      continue;
    }
    return assertSecureRemoteUrl(candidate.url);
  }

  throw new Error(`MCP server "${serverName}" is not a configured remote server.`);
}

export async function resetMcpAuthToAuto(options: {
  projectDirectory: string;
  serverName: string;
  remoteUrl: string;
}): Promise<McpServerItem> {
  const name = options.serverName.trim();
  if (!name) throw new Error("MCP server name is required.");
  const { data, error } = await opencodeClient.mcp.add({
    directory: normalizeDirectoryForMcpApi(options.projectDirectory),
    name,
    config: {
      type: "remote",
      url: assertSecureRemoteUrl(options.remoteUrl),
    },
  });
  if (error || !data) {
    throw new Error(`OpenCode could not reset authentication for MCP server "${name}".`);
  }
  const parsed = parseMcpServerItems(data);
  const server = parsed?.find((item) => item.name === name);
  if (!server) throw new Error(`OpenCode returned an invalid status for MCP server "${name}".`);
  await saveManagedMcpServer({
    projectDirectory: options.projectDirectory,
    name,
    config: { type: "remote", url: options.remoteUrl },
  });
  await removeMcpCredential(options.projectDirectory, name);
  return { ...server, type: "remote" };
}

export async function startMcpOAuth(projectDirectory: string, serverName: string): Promise<McpOAuthStartResult> {
  const name = serverName.trim();
  if (!name) throw new Error("MCP server name is required.");
  const { data, error } = await opencodeClient.mcp.auth.start({
    name,
    directory: normalizeDirectoryForMcpApi(projectDirectory),
  });
  if (error || !data) throw error || new Error("OpenCode did not return an MCP OAuth authorization URL.");
  if (typeof data.authorizationUrl !== "string" || typeof data.oauthState !== "string" || !data.oauthState.trim()) {
    throw new Error("OpenCode returned an invalid MCP OAuth response.");
  }
  if (data.authorizationUrl) {
    const authorizationUrl = new URL(data.authorizationUrl);
    if (authorizationUrl.protocol !== "https:" && authorizationUrl.protocol !== "http:") {
      throw new Error("MCP OAuth authorization URL must use HTTPS or HTTP.");
    }
  }
  return { authorizationUrl: data.authorizationUrl, oauthState: data.oauthState };
}

export async function completeMcpOAuth(
  projectDirectory: string,
  serverName: string,
  authorizationCode: string,
): Promise<McpServerItem> {
  const name = serverName.trim();
  const code = authorizationCode.trim();
  if (!name) throw new Error("MCP server name is required.");
  if (!code) throw new Error("OAuth authorization code is required.");

  const { data, error } = await opencodeClient.mcp.auth.callback({
    name,
    directory: normalizeDirectoryForMcpApi(projectDirectory),
    code,
  });
  if (error || !data) throw error || new Error("OpenCode did not complete MCP OAuth.");

  const parsed = parseMcpServerItems({ [name]: data });
  const server = parsed?.[0];
  if (!server) throw new Error("OpenCode returned an invalid MCP OAuth completion status.");
  return { ...server, type: "remote" };
}

export function parseMcpCommandLine(value: string): string[] {
  const input = value.trim();
  if (!input) throw new Error("MCP local command is required.");
  const result: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;
  let started = false;

  const push = () => {
    if (!started) return;
    result.push(token);
    token = "";
    started = false;
  };

  for (const char of input) {
    if (escaping) {
      token += char;
      started = true;
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/u.test(char)) {
      push();
      continue;
    }
    token += char;
    started = true;
  }

  if (escaping) throw new Error("MCP local command ends with an incomplete escape.");
  if (quote) throw new Error("MCP local command contains an unmatched quote.");
  push();
  if (result.length === 0 || !result[0]?.trim()) {
    throw new Error("MCP local command is required.");
  }
  return result;
}

function normalizeManagedConfig(config: ManagedMcpConfig): McpLocalConfig | McpRemoteConfig {
  if (config.type === "remote") {
    return {
      type: "remote",
      url: assertSecureRemoteUrl(config.url),
      ...(config.enabled === undefined ? {} : { enabled: config.enabled }),
      ...(config.timeout === undefined ? {} : { timeout: config.timeout }),
    };
  }

  if (config.command.length === 0 || !config.command[0]?.trim()) {
    throw new Error("MCP local command is required.");
  }
  return {
    type: "local",
    command: [...config.command],
    ...(config.cwd?.trim() ? { cwd: config.cwd.trim() } : {}),
    ...(config.environment ? { environment: { ...config.environment } } : {}),
    ...(config.enabled === undefined ? {} : { enabled: config.enabled }),
    ...(config.timeout === undefined ? {} : { timeout: config.timeout }),
  };
}

export async function createMcpServer(options: {
  projectDirectory: string;
  name: string;
  config: ManagedMcpConfig;
}): Promise<McpServerItem> {
  const name = options.name.trim();
  if (!name) throw new Error("MCP server name is required.");

  const config = normalizeManagedConfig(options.config);
  const { data, error } = await opencodeClient.mcp.add({
    directory: normalizeDirectoryForMcpApi(options.projectDirectory),
    name,
    config,
  });
  if (error || !data) {
    throw error || new Error(`OpenCode could not add MCP server "${name}".`);
  }

  const parsed = parseMcpServerItems(data);
  const server = parsed?.find((item) => item.name === name);
  if (!server) throw new Error(`OpenCode returned an invalid status for MCP server "${name}".`);

  await saveManagedMcpServer({
    projectDirectory: options.projectDirectory,
    name,
    config: options.config,
  });
  return { ...server, type: config.type };
}

export async function createMcpServerFromInput(options: {
  projectDirectory: string;
  name: string;
  type: "local" | "remote";
  value: string;
}): Promise<McpServerItem> {
  const value = options.value.trim();
  if (!value) {
    throw new Error(
      options.type === "remote"
        ? "MCP server URL is required."
        : "MCP local command is required.",
    );
  }

  return createMcpServer({
    projectDirectory: options.projectDirectory,
    name: options.name,
    config:
      options.type === "remote"
        ? { type: "remote", url: value }
        : { type: "local", command: parseMcpCommandLine(value) },
  });
}

export async function restoreManagedMcpServers(): Promise<{
  restored: number;
  failed: number;
}> {
  let records: ManagedMcpServer[];
  try {
    records = await listManagedMcpServers();
  } catch (error) {
    logger.warn("[McpServer] Managed MCP definitions could not be opened:", error);
    return { restored: 0, failed: 1 };
  }

  let restored = 0;
  let failed = 0;
  for (const record of records) {
    try {
      const { data, error } = await opencodeClient.mcp.add({
        directory: normalizeDirectoryForMcpApi(record.projectDirectory),
        name: record.name,
        config: normalizeManagedConfig(record.config),
      });
      if (error || !data) throw error || new Error("No MCP status returned");
      restored += 1;
    } catch (error) {
      failed += 1;
      const errorName = error instanceof Error ? error.name : "UnknownError";
      logger.warn(
        `[McpServer] Failed to restore managed MCP "${record.name}" (error=${errorName})`,
      );
    }
  }
  return { restored, failed };
}

export async function restoreMcpRuntime(): Promise<{
  managed: { restored: number; failed: number };
  secure: { restored: number; failed: number };
}> {
  const managed = await restoreManagedMcpServers();
  const secure = await restoreSecureMcpConnections();
  return { managed, secure };
}

export async function verifyMcpServerConnection(
  projectDirectory: string,
  serverName: string,
): Promise<McpServerItem> {
  const servers = await loadMcpServers(projectDirectory);
  const server = servers.find((item) => item.name === serverName);
  if (!server) {
    throw new Error(`MCP server "${serverName}" was not found after connection`);
  }
  if (server.status.status !== "connected") {
    const detail =
      "error" in server.status && server.status.error ? `: ${server.status.error}` : "";
    throw new Error(
      `MCP server "${serverName}" did not verify as connected (status=${server.status.status})${detail}`,
    );
  }
  return server;
}

export async function setMcpServerEnabled(
  projectDirectory: string,
  serverName: string,
  enable: boolean,
): Promise<void> {
  const params = {
    name: serverName,
    directory: normalizeDirectoryForMcpApi(projectDirectory),
  };
  if (enable) {
    const { error } = await opencodeClient.mcp.connect(params);
    if (error) throw error;
    try {
      await verifyMcpServerConnection(projectDirectory, serverName);
    } catch (error) {
      await opencodeClient.mcp.disconnect(params).catch(() => {});
      throw error;
    }
    return;
  }
  const { error } = await opencodeClient.mcp.disconnect(params);
  if (error) throw error;
}
