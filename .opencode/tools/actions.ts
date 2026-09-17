import path from "node:path";
import { pathToFileURL } from "node:url";
import { tool } from "@opencode-ai/plugin";

interface AgentActionDefinition {
  id: string;
  tool: string;
  action: string;
  category: string;
  description: string;
  source: "custom" | "opencode" | "runtime" | "dynamic";
  risk: "read" | "write" | "external" | "mutating" | "destructive";
  approval: "allow" | "ask";
  invokeWith: string;
  dynamic?: boolean;
}

interface AgentActionRegistryModule {
  listAgentActions(filters?: Record<string, unknown>): AgentActionDefinition[];
  getAgentAction(id: string): AgentActionDefinition | null;
  getAgentActionSummary(): unknown;
}

const DEFAULT_SERVICE_PATH = "/app/dist/app/services/agent-action-registry-service.js";

function servicePath(): string {
  return process.env.AGENT_ACTION_REGISTRY_SERVICE_PATH?.trim() || DEFAULT_SERVICE_PATH;
}

async function registry(): Promise<AgentActionRegistryModule> {
  const absolute = path.resolve(servicePath());
  return (await import(pathToFileURL(absolute).href)) as AgentActionRegistryModule;
}

function clean(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export default tool({
  description:
    "Discover the bot's normalized agent action catalog. Use actions.list to see capabilities, actions.describe for one action, and actions.capabilities for a compact summary. The catalog covers custom tools, OpenCode built-ins, runtime CLI capabilities, skills, MCP integrations, and remote-control actions; invoke the underlying tool named by invokeWith.",
  args: {
    action: tool.schema.enum(["list", "describe", "capabilities"]).describe("Registry operation."),
    id: tool.schema.string().optional().describe("Action id for describe, for example rustdesk.terminal.exec."),
    tool: tool.schema.string().optional().describe("Filter list by underlying tool name."),
    category: tool.schema.string().optional().describe("Filter list by capability category."),
    source: tool.schema.enum(["custom", "opencode", "runtime", "dynamic"]).optional().describe("Filter list by action source."),
    risk: tool.schema.enum(["read", "write", "external", "mutating", "destructive"]).optional().describe("Filter list by risk class."),
    query: tool.schema.string().optional().describe("Case-insensitive text search over ids, categories and descriptions."),
    limit: tool.schema.number().optional().describe("Maximum list results, default 200 and capped at 500."),
  },
  async execute(args) {
    const module = await registry();

    if (args.action === "capabilities") {
      return JSON.stringify(module.getAgentActionSummary(), null, 2);
    }

    if (args.action === "describe") {
      const id = clean(args.id);
      if (!id) throw new Error("actions.describe requires id");
      const definition = module.getAgentAction(id);
      if (!definition) throw new Error(`Unknown agent action: ${id}`);
      return JSON.stringify(definition, null, 2);
    }

    return JSON.stringify(
      module.listAgentActions({
        tool: clean(args.tool),
        category: clean(args.category),
        source: args.source,
        risk: args.risk,
        query: clean(args.query),
        limit: args.limit,
      }),
      null,
      2,
    );
  },
});
