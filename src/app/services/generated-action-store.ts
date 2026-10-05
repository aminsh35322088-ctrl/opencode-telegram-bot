import { assertGlobalMutationBackend } from "../../control-plane/mutations.js";
import { readAppState, updateAppState } from "../stores/app-state-store.js";
import { isRecord } from "../../utils/type-guards.js";
import type { AgentActionRisk } from "./agent-action-registry.js";
import { getStoredExtension } from "./extension-store.js";

export type GeneratedActionInvocation =
  | { kind: "mcp-tool"; tool: string; server?: string }
  | { kind: "native-tool"; tool: string; arguments?: Record<string, string> }
  | {
      kind: "action-tool";
      tool: string;
      actionArgument: string;
      actionValue: string;
      arguments?: Record<string, string>;
    };

export interface GeneratedActionRecord {
  id: string;
  extensionId: string;
  tool: string;
  action: string;
  category: string;
  risk: AgentActionRisk;
  description: string;
  invocation: GeneratedActionInvocation;
  enabled: boolean;
  userDisabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface GeneratedActionState {
  version: 1;
  records: Record<string, GeneratedActionRecord>;
}

const STORE_KEY = "generatedActions";
const RISKS = new Set<AgentActionRisk>(["read", "write", "external", "mutating", "destructive"]);
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,127}$/u;

function parseRecord(value: unknown): GeneratedActionRecord | null {
  if (!isRecord(value) || !isRecord(value.invocation)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.extensionId !== "string" ||
    typeof value.tool !== "string" ||
    typeof value.action !== "string" ||
    typeof value.category !== "string" ||
    typeof value.risk !== "string" ||
    !RISKS.has(value.risk as AgentActionRisk) ||
    typeof value.description !== "string" ||
    !["mcp-tool", "native-tool", "action-tool"].includes(String(value.invocation.kind)) ||
    typeof value.invocation.tool !== "string" ||
    (value.invocation.server !== undefined && typeof value.invocation.server !== "string") ||
    typeof value.enabled !== "boolean" ||
    typeof value.userDisabled !== "boolean" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  )
    return null;
  return value as unknown as GeneratedActionRecord;
}

function parseState(value: unknown): GeneratedActionState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.records))
    return { version: 1, records: {} };
  const records: Record<string, GeneratedActionRecord> = {};
  for (const [id, candidate] of Object.entries(value.records)) {
    const record = parseRecord(candidate);
    if (record && record.id === id) records[id] = record;
  }
  return { version: 1, records };
}

function classifyRisk(id: string, action: string, tool: string): AgentActionRisk {
  const value = `${id} ${action} ${tool}`.toLowerCase();
  // Match whole segments rather than substrings. MCP tool names are
  // free-form and routinely contain a mutating keyword inside a read verb
  // (`list_deployments`, `show_updates`): substring matching would classify
  // those reads as mutations purely because `deploy`/`update` appears in them.
  // Precedence is unchanged, so a genuinely mutating name still wins.
  const segments = new Set(value.split(/[^a-z0-9]+/u).filter(Boolean));
  const has = (...keywords: string[]): boolean => keywords.some((keyword) => segments.has(keyword));
  if (has("delete", "destroy", "remove", "purge", "drop", "terminate")) return "destructive";
  if (
    has(
      "exec",
      "shell",
      "command",
      "deploy",
      "restart",
      "redeploy",
      "create",
      "update",
      "set",
      "write",
      "upload",
      "trigger",
      "cancel",
    )
  )
    return "mutating";
  if (has("download", "export", "save")) return "write";
  if (
    has(
      "list",
      "get",
      "read",
      "status",
      "inspect",
      "describe",
      "resolve",
      "query",
      "search",
      "view",
      "show",
    )
  )
    return "read";
  return "external";
}

function normalizeId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!ID_PATTERN.test(id)) throw new Error("Generated action id is invalid.");
  return id;
}

/**
 * Namespace every generated action of an Extension must live under. Exported so
 * producers cannot drift from the prefix the store validates against.
 */
export function generatedActionNamespace(extensionName: string): string {
  return (
    extensionName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, ".")
      .replace(/^\.+|\.+$/gu, "") || "extension"
  );
}

export async function listGeneratedActions(extensionId?: string): Promise<GeneratedActionRecord[]> {
  const state = await readAppState();
  return Object.values(parseState(state[STORE_KEY]).records)
    .filter((record) => !extensionId || record.extensionId === extensionId)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function registerGeneratedActionPack(
  extensionId: string,
  actions: Array<{
    id: string;
    tool: string;
    action?: string;
    category?: string;
    description: string;
    invocation?: GeneratedActionInvocation;
  }>,
): Promise<GeneratedActionRecord[]> {
  const extension = await getStoredExtension(extensionId);
  if (!extension) throw new Error("Generated actions require an approved registered Extension.");
  const namespace = generatedActionNamespace(extension.name);
  const now = new Date().toISOString();
  const clean = actions.slice(0, 100).map((candidate) => {
    const id = normalizeId(candidate.id);
    if (!id.startsWith(namespace + ".")) {
      throw new Error(`Generated action ${id} must use the Extension namespace ${namespace}.*`);
    }
    const tool = candidate.tool.trim();
    if (!tool || tool.length > 128)
      throw new Error(`Generated action ${id} has an invalid tool name.`);
    const action = candidate.action?.trim() || id.split(".").at(-1) || "invoke";
    const description = candidate.description.trim().slice(0, 500);
    if (!description) throw new Error(`Generated action ${id} requires a description.`);
    return {
      id,
      tool,
      action,
      category: candidate.category?.trim().slice(0, 80) || "extension",
      description,
      invocation: candidate.invocation ?? { kind: "mcp-tool" as const, tool },
    };
  });

  let result: GeneratedActionRecord[] = [];
  await updateAppState((state) => {
    const current = parseState(state[STORE_KEY]);
    const nextIds = new Set(clean.map((candidate) => candidate.id));
    const records = Object.fromEntries(
      Object.entries(current.records).filter(
        ([, record]) => record.extensionId !== extensionId || nextIds.has(record.id),
      ),
    );
    result = clean.map((candidate) => {
      const previous = records[candidate.id];
      if (previous && previous.extensionId !== extensionId)
        throw new Error(
          `Generated action id already belongs to another extension: ${candidate.id}`,
        );
      const userDisabled = previous?.userDisabled ?? false;
      const record: GeneratedActionRecord = {
        ...candidate,
        extensionId,
        risk: classifyRisk(candidate.id, candidate.action, candidate.tool),
        invocation: candidate.invocation,
        enabled: !userDisabled,
        userDisabled,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      records[record.id] = record;
      return record;
    });
    return { [STORE_KEY]: { version: 1, records } };
  });
  return result;
}

export async function setGeneratedActionEnabled(
  id: string,
  enabled: boolean,
): Promise<GeneratedActionRecord | null> {
  assertGlobalMutationBackend("generated-actions.toggle", id);
  let updated: GeneratedActionRecord | null = null;
  await updateAppState((state) => {
    const current = parseState(state[STORE_KEY]);
    const previous = current.records[id];
    if (!previous) return { [STORE_KEY]: current };
    updated = { ...previous, enabled, userDisabled: !enabled, updatedAt: new Date().toISOString() };
    return { [STORE_KEY]: { version: 1, records: { ...current.records, [id]: updated } } };
  });
  return updated;
}

export async function removeGeneratedActionsForExtension(extensionId: string): Promise<number> {
  let removed = 0;
  await updateAppState((state) => {
    const current = parseState(state[STORE_KEY]);
    const records = Object.fromEntries(
      Object.entries(current.records).filter(([, record]) => {
        if (record.extensionId !== extensionId) return true;
        removed += 1;
        return false;
      }),
    );
    return { [STORE_KEY]: { version: 1, records } };
  });
  return removed;
}
