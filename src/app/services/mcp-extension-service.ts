import { createHash } from "node:crypto";
import type { ExtensionRecord } from "../types/extension.js";
import {
  getStoredExtension,
  removeStoredExtension,
  saveStoredExtension,
} from "./extension-store.js";
import {
  generatedActionNamespace,
  registerGeneratedActionPack,
  removeGeneratedActionsForExtension,
} from "./generated-action-store.js";
import { listMcpServerTools, type McpToolDescriptor } from "./mcp-server-service.js";
import { logger } from "../../utils/logger.js";

/**
 * `registerGeneratedActionPack` keeps at most 100 actions per Extension. Cap the
 * same way here so ordering is deterministic and truncation stays reportable
 * instead of silently dropping the tail of a large tool set.
 */
const MAX_GENERATED_ACTIONS = 100;
const MAX_ID_LENGTH = 128;
const MAX_SEGMENT_LENGTH = 40;

export function mcpExtensionId(serverName: string): string {
  return `mcp:${serverName.trim().toLowerCase()}`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/**
 * MCP tool names are free-form (`deploy`, `list_deployments`, `github/get_issue`)
 * while generated action IDs are restricted. Slugify defensively and fall back
 * to a stable hash so the mapping stays deterministic across syncs.
 */
function actionIdSegment(toolName: string): string {
  const slug = toolName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .slice(0, MAX_SEGMENT_LENGTH)
    .replace(/^-+|-+$/gu, "");
  // The store requires at least two characters, so single-character and
  // symbol-only tool names must fall back to a hash.
  return slug.length >= 2 ? slug : shortHash(toolName);
}

function describeTool(tool: McpToolDescriptor): string {
  const summary = tool.description?.trim() || tool.title?.trim() || `MCP tool ${tool.name}`;
  const required = collectRequiredProperties(tool.inputSchema);
  const suffix = required.length > 0 ? ` Required arguments: ${required.join(", ")}.` : "";
  return `${summary}${suffix}`.slice(0, 500);
}

function collectRequiredProperties(schema: Record<string, unknown> | undefined): string[] {
  if (!schema) return [];
  const properties = schema.properties;
  if (typeof properties !== "object" || properties === null) return [];
  const required = Array.isArray(schema.required) ? schema.required : [];
  return required.filter((name): name is string => typeof name === "string" && name.trim().length > 0).slice(0, 12);
}

export async function ensureMcpExtension(input: {
  serverName: string;
  projectDirectory: string;
  source: string;
}): Promise<ExtensionRecord> {
  const serverName = input.serverName.trim();
  if (!serverName) throw new Error("MCP server name is required.");
  const projectDirectory = input.projectDirectory.trim();
  if (!projectDirectory) throw new Error("MCP project directory is required.");

  const id = mcpExtensionId(serverName);
  const previous = await getStoredExtension(id);
  const now = new Date().toISOString();
  const record: ExtensionRecord = {
    id,
    name: serverName,
    kind: "mcp",
    source: input.source.trim() || serverName,
    purpose: previous?.purpose ?? `Bot-managed MCP server "${serverName}".`,
    authType: "none",
    credentialSchemas: [],
    resource: { kind: "mcp", serverName, projectDirectory },
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    managed: true,
  };
  await saveStoredExtension(record);
  return record;
}

export interface McpActionSyncResult {
  extensionId: string;
  server: string;
  created: number;
  discovered: number;
  truncated: boolean;
}

/**
 * Discovers the server's tools and mirrors each one into the generated-action
 * catalog so it appears in Settings -> Actions and in `actions.list`.
 * Re-running is idempotent: the pack replaces the Extension's previous actions
 * while preserving per-action user enable/disable choices.
 */
export async function syncMcpExtensionActions(input: {
  serverName: string;
  projectDirectory: string;
}): Promise<McpActionSyncResult> {
  const serverName = input.serverName.trim();
  const extensionId = mcpExtensionId(serverName);
  const extension = await getStoredExtension(extensionId);
  if (!extension || extension.resource.kind !== "mcp") {
    throw new Error(`MCP server "${serverName}" has no managed Extension record to attach actions to.`);
  }

  const { tools } = await listMcpServerTools(input.projectDirectory, serverName);
  const namespace = generatedActionNamespace(extension.name);
  const used = new Set<string>();
  const selected = tools.slice(0, MAX_GENERATED_ACTIONS);

  const actions = selected.map((tool) => {
    const segment = actionIdSegment(tool.name);
    let id = `${namespace}.${segment}`;
    if (used.has(id) || id.length > MAX_ID_LENGTH) {
      id = `${namespace}.${segment}-${shortHash(tool.name)}`.slice(0, MAX_ID_LENGTH);
    }
    used.add(id);
    return {
      id,
      tool: "mcp",
      action: "call",
      category: "mcp",
      description: describeTool(tool),
      invocation: { kind: "mcp-tool" as const, server: serverName, tool: tool.name },
    };
  });

  const records = await registerGeneratedActionPack(extensionId, actions);
  const truncated = tools.length > selected.length;
  if (truncated) {
    logger.warn(
      `[McpActions] Server "${serverName}" exposes ${tools.length} tools; only the first ${MAX_GENERATED_ACTIONS} were registered as actions`,
    );
  }
  return { extensionId, server: serverName, created: records.length, discovered: tools.length, truncated };
}

export async function removeMcpExtension(serverName: string): Promise<boolean> {
  const removedActions = await removeGeneratedActionsForExtension(mcpExtensionId(serverName));
  const removedRecord = await removeStoredExtension(mcpExtensionId(serverName));
  if (removedActions > 0) {
    logger.debug(`[McpActions] Removed ${removedActions} generated action(s) for MCP "${serverName}"`);
  }
  return removedRecord;
}

export async function renameMcpExtension(fromName: string, toName: string): Promise<void> {
  const fromId = mcpExtensionId(fromName);
  const toId = mcpExtensionId(toName);
  if (fromId === toId) return;

  const record = await getStoredExtension(fromId);
  await removeGeneratedActionsForExtension(fromId);
  await removeStoredExtension(fromId);
  if (!record) return;

  await saveStoredExtension({
    ...record,
    id: toId,
    name: toName.trim(),
    resource: record.resource.kind === "mcp" ? { ...record.resource, serverName: toName.trim() } : record.resource,
    updatedAt: new Date().toISOString(),
  });
}
