import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  clearMcpServerDeleted,
  listDeletedMcpServerNames,
  listManagedMcpServers,
  loadManagedMcpServer,
  markMcpServerDeleted,
  removeManagedMcpServersByName,
  renameManagedMcpServer,
  saveManagedMcpServer,
  type ManagedMcpConfig,
  type ManagedMcpServer,
} from "./mcp-server-store.js";
import { listTopicRuntimeStates } from "../stores/topic-runtime-state-store.js";

export type McpServerType = "local" | "remote" | "unknown";
export interface McpServerItem { name: string; status: McpStatus; type: McpServerType; }
export interface McpOAuthStartResult { authorizationUrl: string; oauthState: string; }
export interface McpLoginIdentity {
  label: string;
  email?: string;
  username?: string;
  displayName?: string;
  providerHost?: string;
}
const deletedMcpServerNames = new Set<string>();

async function refreshDeletedMcpServerNames(): Promise<void> {
  const names = await listDeletedMcpServerNames();
  deletedMcpServerNames.clear();
  for (const name of names) deletedMcpServerNames.add(name);
}

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
    const normalizedDirectory = normalizeDirectoryForMcpApi(projectDirectory).replace(/\/+$/u, "");
    const credentials = await listMcpCredentials();
    for (const credential of credentials) {
      const credentialDirectory = normalizeDirectoryForMcpApi(credential.projectDirectory).replace(
        /\/+$/u,
        "",
      );
      if (credentialDirectory === normalizedDirectory && !index.has(credential.serverName)) {
        index.set(credential.serverName, "remote");
      }
    }
  } catch (error) {
    logger.debug("[McpServer] Secure MCP metadata unavailable while enriching server types", error);
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
  await ensureMcpRuntimeForDirectory(projectDirectory);
  const { data, error } = await opencodeClient.mcp.status({
    directory: normalizeDirectoryForMcpApi(projectDirectory),
  });
  if (error || !data) throw error || new Error("No MCP status data received");
  const servers = parseMcpServerItems(data);
  if (!servers) throw new Error("Invalid MCP status data format");
  const typeIndex = await loadConfiguredTypeIndex(projectDirectory);
  return servers
    .filter((server) => !deletedMcpServerNames.has(server.name))
    .map((server) => ({
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

function normalizedDirectoryKey(directory: string): string {
  return normalizeDirectoryForMcpApi(directory).replace(/\/+$/u, "");
}

function chooseCanonicalManagedServers(
  records: readonly ManagedMcpServer[],
  projectDirectory: string,
): ManagedMcpServer[] {
  const target = normalizedDirectoryKey(projectDirectory);
  const result = new Map<string, ManagedMcpServer>();
  for (const record of records) {
    if (normalizedDirectoryKey(record.projectDirectory) === target) {
      result.set(record.name, record);
    }
  }
  for (const record of records) {
    if (!result.has(record.name)) result.set(record.name, record);
  }
  return [...result.values()].filter((record) => !deletedMcpServerNames.has(record.name));
}

async function credentialIndexByServerName(): Promise<Map<string, McpCredentialRecord>> {
  const index = new Map<string, McpCredentialRecord>();
  try {
    for (const record of await listMcpCredentials()) {
      if (!index.has(record.serverName)) index.set(record.serverName, record);
    }
  } catch (error) {
    logger.warn("[McpServer] Secure credentials unavailable while synchronizing MCP runtime:", error);
  }
  return index;
}

export async function ensureMcpRuntimeForDirectory(
  projectDirectory: string,
  options: { force?: boolean } = {},
): Promise<{ restored: number; failed: number }> {
  await refreshDeletedMcpServerNames();
  const directory = normalizeDirectoryForMcpApi(projectDirectory);
  for (const name of deletedMcpServerNames) {
    await opencodeClient.mcp.disconnect({ name, directory }).catch(() => {});
  }
  const records = chooseCanonicalManagedServers(await listManagedMcpServers(), projectDirectory);
  const credentials = await credentialIndexByServerName();
  const existingNames = new Set<string>();
  if (!options.force) {
    try {
      const { data, error } = await opencodeClient.mcp.status({ directory });
      if (!error && data) {
        for (const server of parseMcpServerItems(data) ?? []) existingNames.add(server.name);
      }
    } catch {
      // Missing status is handled by the add pass below.
    }
  }
  let restored = 0;
  let failed = 0;

  for (const record of records) {
    if (existingNames.has(record.name)) continue;
    try {
      const credential = credentials.get(record.name);
      const config = credential
        ? buildSecureMcpConfig({ ...credential, projectDirectory } as McpCredentialRecord)
        : normalizeManagedConfig(record.config);
      const { data, error } = await opencodeClient.mcp.add({
        directory,
        name: record.name,
        config,
      });
      if (error || !data) throw error || new Error("No MCP status returned");
      restored += 1;
    } catch (error) {
      failed += 1;
      logger.warn(
        `[McpServer] Failed to synchronize MCP "${record.name}" into directory=${directory}:`,
        error,
      );
    }
  }
  return { restored, failed };
}

async function knownMcpDirectories(extraDirectories: readonly string[] = []): Promise<string[]> {
  const directories = new Map<string, string>();
  const add = (value: string | undefined) => {
    if (!value?.trim()) return;
    const normalized = normalizedDirectoryKey(value);
    if (normalized) directories.set(normalized, value);
  };

  extraDirectories.forEach(add);
  for (const record of await listManagedMcpServers()) add(record.projectDirectory);
  try {
    for (const state of await listTopicRuntimeStates()) {
      add(state.settings.workspaceDirectory ?? state.settings.session?.directory);
    }
  } catch (error) {
    logger.debug("[McpServer] Topic runtime directories unavailable during MCP synchronization", error);
  }
  return [...directories.values()];
}

export async function synchronizeMcpRuntimeToKnownDirectories(
  extraDirectories: readonly string[] = [],
  skipDirectories: readonly string[] = [],
): Promise<{ restored: number; failed: number; directories: number }> {
  const skipped = new Set(skipDirectories.map(normalizedDirectoryKey));
  let restored = 0;
  let failed = 0;
  let directories = 0;
  for (const directory of await knownMcpDirectories(extraDirectories)) {
    if (skipped.has(normalizedDirectoryKey(directory))) continue;
    directories += 1;
    const result = await ensureMcpRuntimeForDirectory(directory, { force: true });
    restored += result.restored;
    failed += result.failed;
  }
  return { restored, failed, directories };
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
    deletedMcpServerNames.delete(record.serverName.trim());
    await clearMcpServerDeleted(record.serverName);
    const synchronized = await synchronizeMcpRuntimeToKnownDirectories(
      [record.projectDirectory],
      [record.projectDirectory],
    );
    if (synchronized.failed > 0) {
      logger.warn(
        `[McpServer] Secure MCP "${record.serverName}" connected locally but failed to synchronize to ${synchronized.failed} runtime target(s)`,
      );
    }
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
      await saveManagedMcpServer({
        projectDirectory: record.projectDirectory,
        name: record.serverName,
        config: { type: "remote", url: record.remoteUrl },
      });
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
  const record =
    await loadMcpCredential(projectDirectory, serverName) ??
    (await listMcpCredentials()).find((candidate) => candidate.serverName === serverName) ??
    null;
  if (!record) return null;
  if (record.mode === "api-key" || record.mode === "custom-header") {
    return { configured: true, mode: record.mode, headerName: record.headerName };
  }
  return { configured: true, mode: record.mode };
}

function oauthAuthFileCandidates(): string[] {
  const candidates = new Set<string>();
  const xdgDataHome = process.env.XDG_DATA_HOME?.trim();
  const home = process.env.HOME?.trim() || os.homedir();
  if (xdgDataHome) candidates.add(path.join(xdgDataHome, "opencode", "mcp-auth.json"));
  if (home) candidates.add(path.join(home, ".local", "share", "opencode", "mcp-auth.json"));
  return [...candidates];
}

function decodeJwtIdentity(accessToken: string): Omit<McpLoginIdentity, "providerHost"> | null {
  const parts = accessToken.split(".");
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!isRecord(payload)) return null;
    const stringClaim = (name: string): string | undefined => {
      const value = payload[name];
      return typeof value === "string" && value.trim() ? value.trim() : undefined;
    };
    const email = stringClaim("email");
    const username =
      stringClaim("preferred_username") ??
      stringClaim("username") ??
      stringClaim("login");
    const displayName = stringClaim("name");
    const subject = stringClaim("sub");
    const label = email ?? username ?? displayName ?? subject;
    return label ? { label, email, username, displayName } : null;
  } catch {
    return null;
  }
}

export async function getMcpLoginIdentity(
  projectDirectory: string,
  serverName: string,
): Promise<McpLoginIdentity | null> {
  let providerHost: string | undefined;
  try {
    providerHost = new URL(await resolveMcpRemoteUrl(projectDirectory, serverName)).host || undefined;
  } catch {
    // Identity lookup is best-effort and must not break the MCP detail view.
  }

  for (const candidate of oauthAuthFileCandidates()) {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(candidate, "utf8"));
      if (!isRecord(parsed)) continue;
      const entry = parsed[serverName];
      if (!isRecord(entry) || !isRecord(entry.tokens)) continue;
      const accessToken = entry.tokens.accessToken;
      if (typeof accessToken !== "string" || !accessToken) continue;
      const identity = decodeJwtIdentity(accessToken);
      if (identity) return { ...identity, ...(providerHost ? { providerHost } : {}) };
      return providerHost ? { label: providerHost, providerHost } : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.debug("[McpServer] Native OAuth identity lookup failed", error);
      }
    }
  }
  return null;
}

export async function resolveMcpRemoteUrl(
  projectDirectory: string,
  serverName: string,
): Promise<string> {
  try {
    const stored =
      await loadMcpCredential(projectDirectory, serverName) ??
      (await listMcpCredentials()).find((candidate) => candidate.serverName === serverName) ??
      null;
    if (stored) return assertSecureRemoteUrl(stored.remoteUrl);
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    logger.warn(
      `[McpServer] Stored auth could not be opened while resolving MCP URL for "${serverName}" (error=${errorName})`,
    );
  }

  try {
    const managed =
      await loadManagedMcpServer(projectDirectory, serverName) ??
      (await listManagedMcpServers()).find((candidate) => candidate.name === serverName) ??
      null;
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
  const credentials = await listMcpCredentials();
  await removeMcpCredential(options.projectDirectory, name);
  const currentDirectory = normalizedDirectoryKey(options.projectDirectory);
  for (const credential of credentials) {
    if (
      credential.serverName === name &&
      normalizedDirectoryKey(credential.projectDirectory) !== currentDirectory
    ) {
      await removeMcpCredential(credential.projectDirectory, name);
    }
  }
  deletedMcpServerNames.delete(name);
  await clearMcpServerDeleted(name);
  await synchronizeMcpRuntimeToKnownDirectories(
    [options.projectDirectory],
    [options.projectDirectory],
  );
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
  deletedMcpServerNames.delete(name);
  await clearMcpServerDeleted(name);
  await synchronizeMcpRuntimeToKnownDirectories([projectDirectory], [projectDirectory]);
  return { ...server, type: "remote" };
}

export function parseMcpCommandLine(value: string): string[] {
  const input = value.trim();
  if (!input) throw new Error("MCP local command is required.");
  const result: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let started = false;

  const push = () => {
    if (!started) return;
    result.push(token);
    token = "";
    started = false;
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? "";
    const next = input[index + 1];

    if (char === "\\" && quote !== "'") {
      const escapesNext =
        next !== undefined &&
        (quote === '"'
          ? next === '"'
          : /\s/u.test(next) || next === '"' || next === "'");

      if (escapesNext) {
        token += next;
        started = true;
        index += 1;
        continue;
      }

      token += "\\";
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

async function createMcpServer(options: {
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
  deletedMcpServerNames.delete(name);
  await clearMcpServerDeleted(name);
  await synchronizeMcpRuntimeToKnownDirectories(
    [options.projectDirectory],
    [options.projectDirectory],
  );
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

async function restoreManagedMcpServers(): Promise<{
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
  await refreshDeletedMcpServerNames();
  const managed = await restoreManagedMcpServers();
  const secure = await restoreSecureMcpConnections();
  const managedSources = (await listManagedMcpServers()).map((record) => record.projectDirectory);
  const synchronized = await synchronizeMcpRuntimeToKnownDirectories([], managedSources);
  if (synchronized.failed > 0) {
    logger.warn(
      `[McpServer] MCP startup synchronization failed for ${synchronized.failed} runtime target(s)`,
    );
  }
  return { managed, secure };
}

async function verifyMcpServerConnection(
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

async function removeMcpCredentialsByName(serverName: string): Promise<number> {
  let removed = 0;
  for (const record of await listMcpCredentials()) {
    if (record.serverName !== serverName) continue;
    if (await removeMcpCredential(record.projectDirectory, serverName)) removed += 1;
  }
  return removed;
}

async function detachMcpRuntimeName(serverName: string, directories: readonly string[]): Promise<void> {
  for (const projectDirectory of directories) {
    const params = {
      name: serverName,
      directory: normalizeDirectoryForMcpApi(projectDirectory),
    };
    await opencodeClient.mcp.disconnect(params).catch(() => {});
    await opencodeClient.mcp.auth.remove(params).catch(() => {});
  }
}

export async function deleteMcpServer(
  projectDirectory: string,
  serverName: string,
): Promise<{ deleted: boolean; name: string }> {
  const name = serverName.trim();
  if (!name) throw new Error("MCP server name is required.");
  const directories = await knownMcpDirectories([projectDirectory]);
  const managed = (await listManagedMcpServers()).some((record) => record.name === name);
  const credentials = (await listMcpCredentials()).some((record) => record.serverName === name);

  await detachMcpRuntimeName(name, directories);
  const removedManaged = await removeManagedMcpServersByName(name);
  const removedCredentials = await removeMcpCredentialsByName(name);
  deletedMcpServerNames.add(name);
  await markMcpServerDeleted(name);

  return {
    deleted: managed || credentials || removedManaged > 0 || removedCredentials > 0,
    name,
  };
}

export async function renameMcpServer(
  projectDirectory: string,
  serverName: string,
  newName: string,
): Promise<McpServerItem> {
  const sourceName = serverName.trim();
  const targetName = newName.trim();
  if (!sourceName || !targetName) throw new Error("MCP server name is required.");
  if (targetName.length > 128) throw new Error("MCP server name must be 128 characters or fewer.");
  if (sourceName === targetName) {
    const current = (await loadMcpServers(projectDirectory)).find((server) => server.name === sourceName);
    if (!current) throw new Error(`MCP server "${sourceName}" was not found.`);
    return current;
  }

  const managedRecords = await listManagedMcpServers();
  if (managedRecords.some((record) => record.name === targetName)) {
    throw new Error(`An MCP server named "${targetName}" already exists.`);
  }
  const source =
    managedRecords.find(
      (record) =>
        record.name === sourceName &&
        normalizedDirectoryKey(record.projectDirectory) === normalizedDirectoryKey(projectDirectory),
    ) ??
    managedRecords.find((record) => record.name === sourceName);
  if (!source) {
    throw new Error(`MCP server "${sourceName}" is not managed by the bot and cannot be renamed safely.`);
  }

  const credentials = await listMcpCredentials();
  const credential = credentials.find((record) => record.serverName === sourceName);
  const targetConfig = credential
    ? buildSecureMcpConfig({ ...credential, projectDirectory } as McpCredentialRecord)
    : normalizeManagedConfig(source.config);
  const { data, error } = await opencodeClient.mcp.add({
    directory: normalizeDirectoryForMcpApi(projectDirectory),
    name: targetName,
    config: targetConfig,
  });
  if (error || !data) throw error || new Error(`OpenCode could not create renamed MCP server "${targetName}".`);

  const renamed = await renameManagedMcpServer(sourceName, targetName);
  if (!renamed) throw new Error(`MCP server "${sourceName}" was not found in managed state.`);

  for (const record of credentials) {
    if (record.serverName !== sourceName) continue;
    await saveMcpCredential({ ...record, serverName: targetName } as McpCredentialRecord);
    await removeMcpCredential(record.projectDirectory, sourceName);
  }

  deletedMcpServerNames.add(sourceName);
  deletedMcpServerNames.delete(targetName);
  await markMcpServerDeleted(sourceName);
  await clearMcpServerDeleted(targetName);
  const directories = await knownMcpDirectories([projectDirectory, source.projectDirectory]);
  await detachMcpRuntimeName(sourceName, directories);
  const synchronized = await synchronizeMcpRuntimeToKnownDirectories(
    [projectDirectory, source.projectDirectory],
  );
  if (synchronized.failed > 0) {
    logger.warn(
      `[McpServer] Renamed MCP "${sourceName}" to "${targetName}" but ${synchronized.failed} runtime target(s) failed to synchronize`,
    );
  }

  const current = (await loadMcpServers(projectDirectory)).find((server) => server.name === targetName);
  if (!current) throw new Error(`Renamed MCP server "${targetName}" is not visible in the current runtime.`);
  return current;
}
