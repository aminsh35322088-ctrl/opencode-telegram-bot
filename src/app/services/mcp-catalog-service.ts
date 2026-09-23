import { promisify } from "node:util";
import { execFile } from "node:child_process";
import type { McpRemoteConfig, McpStatus } from "@opencode-ai/sdk/v2";
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

const execFileAsync = promisify(execFile);

export interface McpCatalogServerItem { name: string; status: McpStatus; }
export interface McpOAuthStartResult { authorizationUrl: string; oauthState: string; }
function normalizeDirectoryForMcpApi(directory: string): string { return directory.replace(/\\/g, "/"); }
const MCP_STATUS_NAMES = ["connected", "disabled", "failed", "needs_auth", "needs_client_registration"] as const;
function isMcpStatusName(value: unknown): value is (typeof MCP_STATUS_NAMES)[number] { return typeof value === "string" && MCP_STATUS_NAMES.some((name) => name === value); }
function buildMcpStatus(statusValue: (typeof MCP_STATUS_NAMES)[number], errorValue: unknown): McpStatus { if (statusValue === "failed" || statusValue === "needs_client_registration") return { status: statusValue, error: typeof errorValue === "string" ? errorValue : "" }; return { status: statusValue }; }
type ParsedMcpServerStatus = { kind: "ok"; status: McpStatus } | { kind: "skip" } | { kind: "invalid" };
function parseMcpServerStatus(status: unknown): ParsedMcpServerStatus {
  if (!isRecord(status)) return { kind: "invalid" };
  if (!isMcpStatusName(status.status)) { if (typeof status.status === "string") { logger.debug(`[McpCatalog] Unknown MCP status "${status.status}", skipping server`); return { kind: "skip" }; } return { kind: "invalid" }; }
  return { kind: "ok", status: buildMcpStatus(status.status, status.error) };
}
export function parseMcpCatalogServers(value: unknown): McpCatalogServerItem[] | null {
  if (!isRecord(value)) return null;
  if (Array.isArray(value)) {
    const servers: McpCatalogServerItem[] = [];
    for (const item of value) { if (!isRecord(item) || typeof item.name !== "string") return null; const parsed = parseMcpServerStatus(item.status); if (parsed.kind === "invalid") return null; if (parsed.kind === "skip") continue; servers.push({ name: item.name, status: parsed.status }); }
    return servers;
  }
  const servers: McpCatalogServerItem[] = [];
  for (const [name, statusValue] of Object.entries(value)) { const parsed = parseMcpServerStatus(statusValue); if (parsed.kind === "invalid") return null; if (parsed.kind === "skip") continue; servers.push({ name, status: parsed.status }); }
  return servers;
}
export async function loadMcpCatalog(projectDirectory: string): Promise<McpCatalogServerItem[]> {
  const { data, error } = await opencodeClient.mcp.status({ directory: normalizeDirectoryForMcpApi(projectDirectory) });
  if (error || !data) throw error || new Error("No MCP status data received");
  const servers = parseMcpCatalogServers(data); if (!servers) throw new Error("Invalid MCP status data format");
  return servers;
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

async function addSecureMcpDefinition(record: McpCredentialRecord): Promise<McpCatalogServerItem> {
  const name = record.serverName.trim();
  if (!name) throw new Error("MCP server name is required.");
  const { data, error } = await opencodeClient.mcp.add({
    directory: normalizeDirectoryForMcpApi(record.projectDirectory),
    name,
    config: buildSecureMcpConfig(record),
  });
  if (error || !data) {
    throw new Error(`OpenCode could not configure secure MCP server "${name}".`);
  }
  const parsed = parseMcpCatalogServers(data);
  const server = parsed?.find((item) => item.name === name);
  if (!server) throw new Error(`OpenCode returned an invalid status for MCP server "${name}".`);
  return server;
}

export async function configureSecureMcpAuth(
  record: McpCredentialRecord,
): Promise<McpCatalogServerItem> {
  const server = await addSecureMcpDefinition(record);
  await saveMcpCredential(record);
  return server;
}

export async function restoreSecureMcpConnections(): Promise<{ restored: number; failed: number }> {
  let records: McpCredentialRecord[];
  try {
    records = await listMcpCredentials();
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    logger.warn(`[McpCatalog] Secure MCP credentials could not be opened (error=${errorName})`);
    return { restored: 0, failed: 1 };
  }

  let restored = 0;
  let failed = 0;
  for (const record of records) {
    try {
      await addSecureMcpDefinition(record);
      restored += 1;
    } catch (error) {
      failed += 1;
      const errorName = error instanceof Error ? error.name : "UnknownError";
      logger.warn(
        `[McpCatalog] Failed to restore secure MCP "${record.serverName}" (error=${errorName})`,
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
      `[McpCatalog] Stored auth could not be opened while resolving MCP URL for "${serverName}" (error=${errorName})`,
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
}): Promise<McpCatalogServerItem> {
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
  const parsed = parseMcpCatalogServers(data);
  const server = parsed?.find((item) => item.name === name);
  if (!server) throw new Error(`OpenCode returned an invalid status for MCP server "${name}".`);
  await removeMcpCredential(options.projectDirectory, name);
  return server;
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
): Promise<McpCatalogServerItem> {
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

  const parsed = parseMcpCatalogServers({ [name]: data });
  const server = parsed?.[0];
  if (!server) throw new Error("OpenCode returned an invalid MCP OAuth completion status.");
  return server;
}

export async function removeMcpOAuth(projectDirectory: string, serverName: string): Promise<void> {
  const name = serverName.trim();
  if (!name) throw new Error("MCP server name is required.");
  const params = { name, directory: normalizeDirectoryForMcpApi(projectDirectory) };
  const { error } = await opencodeClient.mcp.auth.remove(params);
  if (error) throw error;
  await opencodeClient.mcp.disconnect(params).catch(() => {});
}
export async function verifyMcpServerConnection(projectDirectory: string, serverName: string): Promise<McpCatalogServerItem> {
  const servers = await loadMcpCatalog(projectDirectory);
  const server = servers.find((item) => item.name === serverName);
  if (!server) throw new Error(`MCP server "${serverName}" was not found after connection`);
  if (server.status.status !== "connected") { const detail = "error" in server.status && server.status.error ? `: ${server.status.error}` : ""; throw new Error(`MCP server "${serverName}" did not verify as connected (status=${server.status.status})${detail}`); }
  return server;
}
export async function addMcpCatalogServer(options: { projectDirectory: string; name: string; type: "local" | "remote"; value: string }): Promise<void> {
  const name = options.name.trim();
  const value = options.value.trim();
  if (!name) throw new Error("MCP server name is required.");
  if (!value) throw new Error(options.type === "remote" ? "MCP server URL is required." : "MCP server command is required.");

  const args = options.type === "remote"
    ? ["mcp", "add", name, "--url", value]
    : ["mcp", "add", name, "--", ...value.split(/\s+/u)];

  try {
    const { stdout, stderr } = await execFileAsync("opencode", args, {
      cwd: options.projectDirectory,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
    logger.info(`[McpCatalog] Added ${options.type} MCP server "${name}"${output ? `: ${output.slice(-500)}` : ""}`);
  } catch (error) {
    logger.error(`[McpCatalog] Failed to add ${options.type} MCP server "${name}":`, error);
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}
export async function toggleMcpCatalogServer(projectDirectory: string, serverName: string, enable: boolean): Promise<void> {
  const params = { name: serverName, directory: normalizeDirectoryForMcpApi(projectDirectory) };
  if (enable) {
    const { error } = await opencodeClient.mcp.connect(params); if (error) throw error;
    try { await verifyMcpServerConnection(projectDirectory, serverName); } catch (error) { await opencodeClient.mcp.disconnect(params).catch(() => {}); throw error; }
    return;
  }
  const { error } = await opencodeClient.mcp.disconnect(params); if (error) throw error;
}
