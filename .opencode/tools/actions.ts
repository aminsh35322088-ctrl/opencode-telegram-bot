import { pathToFileURL } from "node:url";
import { tool } from "@opencode-ai/plugin";

interface AgentActionDefinition {
  id: string;
  tool: string;
  action: string;
  source: string;
  category: string;
  risk: string;
  description: string;
  invocation: Record<string, unknown>;
}

interface RegistryModule {
  getAgentAction(id: string): AgentActionDefinition | null;
  listAgentActions(filters?: Record<string, string | undefined>): AgentActionDefinition[];
  summarizeAgentActions(): Record<string, unknown>;
  getAgentActionSources(): Record<string, unknown>;
}

const DEFAULT_REGISTRY_PATH = "/app/dist/app/services/agent-action-registry.js";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 250;

function registryPath(): string {
  return process.env.AGENT_ACTION_REGISTRY_PATH?.trim() || DEFAULT_REGISTRY_PATH;
}

async function getRegistry(): Promise<RegistryModule> {
  return import(pathToFileURL(registryPath()).href) as Promise<RegistryModule>;
}

function clean(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function limit(value?: number): number {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.trunc(value ?? DEFAULT_LIMIT), MAX_LIMIT));
}

function output(value: unknown): string {
  return JSON.stringify(value, null, 2).slice(0, 30000);
}

export default tool({
  description:
    "Discover the unified model-facing action catalog. Use action=list to find capabilities, describe/resolve for an exact canonical action ID, sources to understand native/custom/plugin/MCP action sources, and summary for counts. The catalog does not execute other tools; resolve returns the exact tool/action invocation the model should call next.",
  args: {
    action: tool.schema.enum(["list", "describe", "resolve", "sources", "summary"]).describe("Action-registry operation."),
    id: tool.schema.string().optional().describe("Canonical action ID such as browser.goto, railway.logs, github-ci.status, or bash.exec."),
    tool_name: tool.schema.string().optional().describe("For list: exact tool-name filter."),
    category: tool.schema.string().optional().describe("For list: exact category filter."),
    source: tool.schema.enum(["opencode-core", "custom-tool", "plugin", "dynamic-mcp"]).optional().describe("For list: action source filter."),
    risk: tool.schema.enum(["read", "write", "external", "mutating", "destructive"]).optional().describe("For list: risk filter."),
    query: tool.schema.string().optional().describe("For list: case-insensitive search across action ID, description, and category."),
    limit: tool.schema.number().optional().describe(`Maximum list entries, default ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT}.`),
  },
  async execute(args) {
    const registry = await getRegistry();

    if (args.action === "sources") return output(registry.getAgentActionSources());
    if (args.action === "summary") return output(registry.summarizeAgentActions());

    if (args.action === "list") {
      const actions = registry.listAgentActions({
        tool: clean(args.tool_name),
        category: clean(args.category),
        source: args.source,
        risk: args.risk,
        query: clean(args.query),
      });
      const selected = actions.slice(0, limit(args.limit));
      return output({ count: selected.length, totalMatches: actions.length, actions: selected });
    }

    const id = clean(args.id);
    if (!id) throw new Error(`${args.action} requires id`);
    const definition = registry.getAgentAction(id);
    if (!definition) throw new Error(`Unknown agent action: ${id}. Call actions(action=\"list\") to discover available actions.`);

    if (args.action === "resolve") {
      return output({ id: definition.id, invocation: definition.invocation, risk: definition.risk, description: definition.description });
    }
    return output(definition);
  },
});
