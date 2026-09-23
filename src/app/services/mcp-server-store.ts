import { createHash } from "node:crypto";
import type { McpLocalConfig, McpRemoteConfig } from "@opencode-ai/sdk/v2";
import { readAppState, updateAppState } from "../stores/app-state-store.js";
import { isRecord } from "../../utils/type-guards.js";

export type ManagedMcpConfig =
  | Pick<McpLocalConfig, "type" | "command" | "cwd" | "environment" | "enabled" | "timeout">
  | Pick<McpRemoteConfig, "type" | "url" | "enabled" | "timeout">;

export interface ManagedMcpServer {
  projectDirectory: string;
  name: string;
  config: ManagedMcpConfig;
}

interface McpServerState {
  version: 1;
  records: Record<string, ManagedMcpServer>;
}

const STORE_KEY = "mcpServers";

function normalizeDirectory(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/u, "");
}

function serverId(projectDirectory: string, name: string): string {
  return createHash("sha256")
    .update(normalizeDirectory(projectDirectory))
    .update("\0")
    .update(name.trim())
    .digest("hex");
}

function normalizeHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("MCP remote URL must be an absolute HTTP(S) URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("MCP remote URL must be an absolute HTTP(S) URL.");
  }
  return url.toString();
}

function normalizeTimeout(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) throw new Error("MCP timeout must be a positive number.");
  return Math.round(value);
}

function normalizeConfig(config: ManagedMcpConfig): ManagedMcpConfig {
  const timeout = normalizeTimeout(config.timeout);
  if (config.type === "remote") {
    return {
      type: "remote",
      url: normalizeHttpUrl(config.url),
      ...(config.enabled === undefined ? {} : { enabled: config.enabled }),
      ...(timeout === undefined ? {} : { timeout }),
    };
  }

  const command = [...config.command];
  if (command.length === 0 || !command[0]?.trim()) {
    throw new Error("MCP local command is required.");
  }
  command[0] = command[0].trim();
  const cwd = config.cwd?.trim();
  const environment = config.environment
    ? Object.fromEntries(
        Object.entries(config.environment)
          .map(([key, value]) => [key.trim(), value] as const)
          .filter(([key]) => key.length > 0),
      )
    : undefined;
  return {
    type: "local",
    command,
    ...(cwd ? { cwd } : {}),
    ...(environment && Object.keys(environment).length > 0 ? { environment } : {}),
    ...(config.enabled === undefined ? {} : { enabled: config.enabled }),
    ...(timeout === undefined ? {} : { timeout }),
  };
}

function normalizeServer(server: ManagedMcpServer): ManagedMcpServer {
  const projectDirectory = normalizeDirectory(server.projectDirectory);
  const name = server.name.trim();
  if (!projectDirectory) throw new Error("MCP project directory is required.");
  if (!name) throw new Error("MCP server name is required.");
  return { projectDirectory, name, config: normalizeConfig(server.config) };
}

function isManagedConfig(value: unknown): value is ManagedMcpConfig {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "remote") {
    return (
      typeof value.url === "string" &&
      (value.enabled === undefined || typeof value.enabled === "boolean") &&
      (value.timeout === undefined || typeof value.timeout === "number")
    );
  }
  if (value.type !== "local" || !Array.isArray(value.command) || !value.command.every((item) => typeof item === "string")) {
    return false;
  }
  if (value.cwd !== undefined && typeof value.cwd !== "string") return false;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") return false;
  if (value.timeout !== undefined && typeof value.timeout !== "number") return false;
  if (value.environment !== undefined) {
    if (!isRecord(value.environment)) return false;
    if (!Object.values(value.environment).every((item) => typeof item === "string")) return false;
  }
  return true;
}

function parseState(value: unknown): McpServerState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.records)) {
    return { version: 1, records: {} };
  }

  const records: Record<string, ManagedMcpServer> = {};
  for (const [id, candidate] of Object.entries(value.records)) {
    if (
      !isRecord(candidate) ||
      typeof candidate.projectDirectory !== "string" ||
      typeof candidate.name !== "string" ||
      !isManagedConfig(candidate.config)
    ) {
      continue;
    }
    try {
      records[id] = normalizeServer({
        projectDirectory: candidate.projectDirectory,
        name: candidate.name,
        config: candidate.config,
      });
    } catch {
      // Invalid legacy/corrupt non-secret records are ignored.
    }
  }
  return { version: 1, records };
}

export async function saveManagedMcpServer(server: ManagedMcpServer): Promise<void> {
  const normalized = normalizeServer(server);
  const id = serverId(normalized.projectDirectory, normalized.name);
  await updateAppState((state) => {
    const current = parseState(state[STORE_KEY]);
    return {
      [STORE_KEY]: {
        version: 1,
        records: { ...current.records, [id]: normalized },
      },
    };
  });
}

export async function loadManagedMcpServer(
  projectDirectory: string,
  name: string,
): Promise<ManagedMcpServer | null> {
  const state = await readAppState();
  const current = parseState(state[STORE_KEY]);
  return current.records[serverId(projectDirectory, name)] ?? null;
}

export async function listManagedMcpServers(projectDirectory?: string): Promise<ManagedMcpServer[]> {
  const state = await readAppState();
  const current = parseState(state[STORE_KEY]);
  const normalizedDirectory = projectDirectory ? normalizeDirectory(projectDirectory) : null;
  return Object.values(current.records).filter(
    (server) => normalizedDirectory === null || server.projectDirectory === normalizedDirectory,
  );
}
