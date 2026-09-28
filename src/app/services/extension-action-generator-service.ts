import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";
import type { ExtensionRecord } from "../types/extension.js";
import { registerGeneratedActionPack, removeGeneratedActionsForExtension } from "./generated-action-store.js";
import { discoverMcpToolIds } from "./mcp-tool-discovery-service.js";

function authorizationHeader(): string | undefined {
  if (!config.opencode.password) return undefined;
  const value = Buffer.from(`${config.opencode.username}:${config.opencode.password}`).toString("base64");
  return `Basic ${value}`;
}

function namespace(value: string): string {
  return value.trim().toLowerCase()
    .replace(/[^a-z0-9]+/gu, ".")
    .replace(/^\.+|\.+$/gu, "") || "extension";
}

async function listOpenCodeToolIds(directory: string): Promise<string[]> {
  const url = new URL("/experimental/tool/ids", config.opencode.apiUrl);
  url.searchParams.set("directory", directory);
  const auth = authorizationHeader();
  const response = await fetch(url, {
    headers: auth ? { Authorization: auth } : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`OpenCode tool discovery returned HTTP ${response.status}.`);
  }
  const payload = await response.json() as unknown;
  if (Array.isArray(payload) && payload.every((item) => typeof item === "string")) {
    return payload;
  }
  if (
    payload && typeof payload === "object"
    && "tools" in payload
    && Array.isArray((payload as { tools?: unknown }).tools)
  ) {
    return (payload as { tools: unknown[] }).tools.filter((item): item is string => typeof item === "string");
  }
  throw new Error("OpenCode returned an invalid tool-id payload.");
}

function mcpToolIds(serverName: string, ids: string[]): string[] {
  const prefix = serverName + "_";
  return ids.filter((id) => id.startsWith(prefix)).sort();
}

export async function generateExtensionActions(extension: ExtensionRecord): Promise<number> {
  if (extension.resource.kind === "skill") {
    const ns = namespace(extension.name);
    const records = await registerGeneratedActionPack(extension.id, [{
      id: `${ns}.load`,
      tool: "skill",
      action: "load",
      category: "skill",
      description: `Load the installed ${extension.name} skill.`,
      invocation: {
        kind: "native-tool",
        tool: "skill",
        arguments: { name: extension.resource.skillName },
      },
    }]);
    return records.length;
  }

  if (extension.resource.kind !== "mcp") return 0;

  try {
    const serverName = extension.resource.serverName;
    const primaryIds = mcpToolIds(
      serverName,
      await listOpenCodeToolIds(extension.resource.projectDirectory),
    );
    let ids = primaryIds;
    if (ids.length === 0) {
      try {
        ids = mcpToolIds(
          serverName,
          await discoverMcpToolIds(
            extension.resource.projectDirectory,
            serverName,
          ),
        );
      } catch (error) {
        logger.debug(
          `[Extensions] Direct MCP tool discovery unavailable for ${extension.id}`,
          error instanceof Error ? error.name : "UnknownError",
        );
      }
    }
    if (ids.length === 0) {
      await removeGeneratedActionsForExtension(extension.id);
      return 0;
    }
    const ns = namespace(extension.name);
    const prefix = extension.resource.serverName + "_";
    const actions = ids.map((toolId) => {
      const suffix = toolId.slice(prefix.length)
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/gu, ".")
        .replace(/^\.+|\.+$/gu, "") || "invoke";
      return {
        id: `${ns}.${suffix}`,
        tool: toolId,
        action: suffix,
        category: extension.kind === "integration" ? "integration" : "mcp",
        description: `${extension.name}: ${toolId}.`,
      };
    });
    const records = await registerGeneratedActionPack(extension.id, actions);
    return records.length;
  } catch (error) {
    logger.warn(
      `[Extensions] Could not generate actions for ${extension.id}`,
      error instanceof Error ? error.name : "UnknownError",
    );
    return 0;
  }
}
