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
const TOMBSTONE_STORE_KEY = "mcpServerTombstones";

interface McpServerTombstoneState {
  version: 1;
  names: string[];
}

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

function parseTombstoneState(value: unknown): McpServerTombstoneState {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.names)) {
    return { version: 1, names: [] };
  }
  const names = [...new Set(
    value.names
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean),
  )];
  return { version: 1, names };
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
    const records = Object.fromEntries(
      Object.entries(current.records).filter(([, candidate]) => candidate.name !== normalized.name),
    );
    return {
      [STORE_KEY]: {
        version: 1,
        records: { ...records, [id]: normalized },
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

export async function removeManagedMcpServersByName(name: string): Promise<number> {
  const normalizedName = name.trim();
  if (!normalizedName) return 0;
  let removed = 0;
  await updateAppState((state) => {
    const current = parseState(state[STORE_KEY]);
    const records = Object.fromEntries(
      Object.entries(current.records).filter(([, candidate]) => {
        if (candidate.name !== normalizedName) return true;
        removed += 1;
        return false;
      }),
    );
    return { [STORE_KEY]: { version: 1, records } };
  });
  return removed;
}

export async function listDeletedMcpServerNames(): Promise<string[]> {
  const state = await readAppState();
  return parseTombstoneState(state[TOMBSTONE_STORE_KEY]).names;
}

export async function markMcpServerDeleted(name: string): Promise<void> {
  const normalizedName = name.trim();
  if (!normalizedName) return;
  await updateAppState((state) => {
    const current = parseTombstoneState(state[TOMBSTONE_STORE_KEY]);
    return {
      [TOMBSTONE_STORE_KEY]: {
        version: 1,
        names: [...new Set([...current.names, normalizedName])],
      },
    };
  });
}

export async function clearMcpServerDeleted(name: string): Promise<void> {
  const normalizedName = name.trim();
  if (!normalizedName) return;
  await updateAppState((state) => {
    const current = parseTombstoneState(state[TOMBSTONE_STORE_KEY]);
    return {
      [TOMBSTONE_STORE_KEY]: {
        version: 1,
        names: current.names.filter((candidate) => candidate !== normalizedName),
      },
    };
  });
}

export async function renameManagedMcpServer(
  oldName: string,
  newName: string,
): Promise<ManagedMcpServer | null> {
  const sourceName = oldName.trim();
  const targetName = newName.trim();
  if (!sourceName || !targetName) throw new Error("MCP server name is required.");
  if (sourceName === targetName) {
    return (await listManagedMcpServers()).find((item) => item.name === sourceName) ?? null;
  }

  let renamed: ManagedMcpServer | null = null;
  await updateAppState((state) => {
    const current = parseState(state[STORE_KEY]);
    if (Object.values(current.records).some((candidate) => candidate.name === targetName)) {
      throw new Error("An MCP server named \"" + targetName + "\" already exists.");
    }
    const source = Object.values(current.records).find((candidate) => candidate.name === sourceName);
    if (!source) return { [STORE_KEY]: current };

    renamed = normalizeServer({ ...source, name: targetName });
    const records = Object.fromEntries(
      Object.entries(current.records).filter(([, candidate]) => candidate.name !== sourceName),
    );
    records[serverId(renamed.projectDirectory, renamed.name)] = renamed;
    return { [STORE_KEY]: { version: 1, records } };
  });
  return renamed;
}
