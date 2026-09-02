import type { McpStatus } from "@opencode-ai/sdk/v2";
import { opencodeClient } from "../../opencode/client.js";
import { logger } from "../../utils/logger.js";
import { isRecord } from "../../utils/type-guards.js";

export interface McpCatalogServerItem { name: string; status: McpStatus; }
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
export async function verifyMcpServerConnection(projectDirectory: string, serverName: string): Promise<McpCatalogServerItem> {
  const servers = await loadMcpCatalog(projectDirectory);
  const server = servers.find((item) => item.name === serverName);
  if (!server) throw new Error(`MCP server "${serverName}" was not found after connection`);
  if (server.status.status !== "connected") { const detail = "error" in server.status && server.status.error ? `: ${server.status.error}` : ""; throw new Error(`MCP server "${serverName}" did not verify as connected (status=${server.status.status})${detail}`); }
  return server;
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
