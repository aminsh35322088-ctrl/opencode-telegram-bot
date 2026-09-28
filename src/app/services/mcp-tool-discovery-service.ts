import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getMcpDiscoveryHeaders } from "./mcp-server-service.js";
import { loadManagedMcpServer } from "./mcp-server-store.js";

const DISCOVERY_TIMEOUT_MS = 10_000;
const MAX_DISCOVERED_TOOLS = 500;

function prefixedToolId(serverName: string, toolName: string): string {
  return `${serverName}_${toolName}`;
}

async function listTools(client: Client): Promise<string[]> {
  const names = new Set<string>();
  let cursor: string | undefined;
  do {
    const result = await client.listTools(
      cursor ? { cursor } : undefined,
      { timeout: DISCOVERY_TIMEOUT_MS },
    );
    for (const tool of result.tools) {
      const name = tool.name.trim();
      if (name) names.add(name);
      if (names.size >= MAX_DISCOVERED_TOOLS) break;
    }
    if (names.size >= MAX_DISCOVERED_TOOLS) break;
    cursor = result.nextCursor;
  } while (cursor);
  return [...names].sort();
}

export async function discoverMcpToolIds(
  projectDirectory: string,
  serverName: string,
): Promise<string[]> {
  const managed = await loadManagedMcpServer(projectDirectory, serverName);
  if (!managed) throw new Error(`Managed MCP server not found: ${serverName}.`);

  const client = new Client(
    { name: "opencode-telegram-bot-action-discovery", version: "1.0.0" },
    { capabilities: {} },
  );

  const transport = managed.config.type === "local"
    ? new StdioClientTransport({
        command: managed.config.command[0]!,
        args: managed.config.command.slice(1),
        cwd: managed.config.cwd ?? projectDirectory,
        env: {
          ...getDefaultEnvironment(),
          ...(managed.config.environment ?? {}),
        },
        stderr: "pipe",
      })
    : new StreamableHTTPClientTransport(
        new URL(managed.config.url),
        {
          requestInit: {
            headers: await getMcpDiscoveryHeaders(projectDirectory, serverName),
          },
        },
      );

  try {
    await client.connect(transport, { timeout: DISCOVERY_TIMEOUT_MS });
    const names = await listTools(client);
    return names.map((name) => prefixedToolId(serverName, name));
  } finally {
    await client.close().catch(() => {});
  }
}
