import path from "node:path";
import { pathToFileURL } from "node:url";
import { tool } from "@opencode-ai/plugin";

const BOT_ACTIONS = [
  "capabilities.list",
  "projects.list",
  "worktree.context",
  "models.providers",
  "models.list",
  "models.search",
  "models.refresh",
  "agents.list",
  "variants.list",
  "skills.list",
  "skills.create",
  "skills.update",
  "skills.delete",
  "commands.list",
  "mcp.list",
  "mcp.add-local",
  "mcp.add-remote",
  "mcp.enable",
  "mcp.disable",
  "memory.list",
  "memory.search",
  "memory.add",
  "memory.remove",
  "memory.clear",
  "providers.list",
  "providers.get",
  "providers.stt-status",
  "version.info",
] as const;

const DIST_ROOT = process.env.AGENT_BOT_DIST_ROOT?.trim() || "/app/dist";

type BotAction = (typeof BOT_ACTIONS)[number];
type MemoryScope = "user" | "project";

interface ProjectModule {
  getProjects(): Promise<unknown[]>;
}
interface WorktreeModule {
  getGitWorktreeContext(worktree: string): Promise<unknown>;
}
interface ModelModule {
  getProviders(): Promise<unknown[]>;
  getProviderModels(providerID: string): Promise<unknown[]>;
  searchModels(query: string): Promise<unknown[]>;
  refreshModelCatalog(): Promise<void>;
}
interface VariantModule {
  getAvailableVariants(providerID: string, modelID: string): Promise<unknown[]>;
}
interface SkillsCatalogModule {
  loadSkillsCatalog(projectDirectory: string): Promise<unknown[]>;
}
interface SkillManageModule {
  writeGlobalSkill(input: { name: string; description: string; body: string }): Promise<string>;
  updateGlobalSkill(input: { name: string; description: string; body: string }): Promise<string>;
  deleteGlobalSkill(name: string): Promise<boolean>;
}
interface CommandCatalogModule {
  loadCommandCatalog(projectDirectory: string): Promise<unknown[]>;
}
interface McpModule {
  loadMcpCatalog(projectDirectory: string): Promise<unknown[]>;
  addMcpCatalogServer(options: { projectDirectory: string; name: string; type: "local" | "remote"; value: string }): Promise<void>;
  toggleMcpCatalogServer(projectDirectory: string, serverName: string, enable: boolean): Promise<void>;
}
interface MemoryModule {
  listMemories(scope?: MemoryScope, projectId?: string): Promise<unknown[]>;
  searchRelevantMemories(input: { query: string; projectId?: string; projectDirectory?: string; maxChars?: number }): Promise<unknown[]>;
  addMemory(input: { scope: MemoryScope; content: string; projectId?: string; projectDirectory?: string }): Promise<unknown>;
  removeMemory(id: string): Promise<boolean>;
  clearAllMemories(): Promise<number>;
}
interface ProviderModule {
  listCustomProviders(): Promise<unknown[]>;
  getCustomProvider(id: string): Promise<unknown>;
  isGroqSttConfigured(): Promise<boolean>;
}
interface VersionModule {
  getVersionSnapshot(): Promise<unknown>;
}
interface OpenCodeModule {
  opencodeClient: {
    app: {
      agents(input?: { directory?: string }): Promise<{ data?: Array<{ name?: string; description?: string; mode?: string; hidden?: boolean }>; error?: unknown }>;
    };
  };
}

async function load<T>(relativePath: string): Promise<T> {
  const absolutePath = path.join(DIST_ROOT, relativePath);
  return import(pathToFileURL(absolutePath).href) as Promise<T>;
}

function required(value: string | undefined, field: string, action: BotAction): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${action} requires ${field}`);
  return normalized;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2).slice(0, 30000);
}

export default tool({
  description:
    "Access the bot control-plane capabilities that are safe and useful to the coding agent. Every operation is an explicit action. Secrets are never returned; provider setup that requires API keys stays in the Telegram UI.",
  args: {
    action: tool.schema.enum(BOT_ACTIONS).describe("Bot capability action to execute."),
    provider_id: tool.schema.string().optional().describe("Provider ID for model/provider actions."),
    model_id: tool.schema.string().optional().describe("Model ID for variant actions."),
    query: tool.schema.string().optional().describe("Search query for model or memory search."),
    name: tool.schema.string().optional().describe("Skill or MCP server name."),
    description: tool.schema.string().optional().describe("Skill description for create/update."),
    body: tool.schema.string().optional().describe("Skill body for create/update."),
    value: tool.schema.string().optional().describe("MCP URL or local MCP command for add actions."),
    scope: tool.schema.enum(["user", "project"]).optional().describe("Memory scope; defaults to user."),
    content: tool.schema.string().optional().describe("Memory content for memory.add."),
    id: tool.schema.string().optional().describe("Memory ID for memory.remove."),
    project_id: tool.schema.string().optional().describe("Optional project ID for project-scoped memory."),
    max_chars: tool.schema.number().optional().describe("Optional memory-search result character budget."),
  },
  async execute(args, context) {
    const action = args.action as BotAction;

    if (action === "capabilities.list") {
      return json({
        actions: BOT_ACTIONS,
        notes: {
          secretConfiguration: "API keys and other credentials remain Telegram-UI-only and are not accepted by this tool.",
          sessionRecovery: "Use the dedicated session-recovery tool for inspect/abort/continue.",
          remoteControl: "Use the dedicated rustdesk tool for authorized remote-device control.",
          dynamicMcpTools: "Connected MCP servers expose their own model tools directly through OpenCode.",
        },
      });
    }

    if (action === "projects.list") {
      const service = await load<ProjectModule>("app/services/project-service.js");
      return json(await service.getProjects());
    }

    if (action === "worktree.context") {
      const service = await load<WorktreeModule>("app/services/worktree-service.js");
      return json(await service.getGitWorktreeContext(context.worktree));
    }

    if (action === "models.providers") {
      const service = await load<ModelModule>("app/services/model-selection-service.js");
      return json(await service.getProviders());
    }

    if (action === "models.list") {
      const providerID = required(args.provider_id, "provider_id", action);
      const service = await load<ModelModule>("app/services/model-selection-service.js");
      return json(await service.getProviderModels(providerID));
    }

    if (action === "models.search") {
      const query = required(args.query, "query", action);
      const service = await load<ModelModule>("app/services/model-selection-service.js");
      return json(await service.searchModels(query));
    }

    if (action === "models.refresh") {
      const service = await load<ModelModule>("app/services/model-selection-service.js");
      await service.refreshModelCatalog();
      return json({ ok: true, refreshed: true });
    }

    if (action === "agents.list") {
      const module = await load<OpenCodeModule>("opencode/client.js");
      const result = await module.opencodeClient.app.agents({ directory: context.worktree.replace(/\\/g, "/") });
      if (result.error) throw result.error;
      const agents = (result.data ?? []).filter((agent) => !agent.hidden && (agent.mode === "primary" || agent.mode === "all"));
      return json(agents);
    }

    if (action === "variants.list") {
      const providerID = required(args.provider_id, "provider_id", action);
      const modelID = required(args.model_id, "model_id", action);
      const service = await load<VariantModule>("app/services/variant-selection-service.js");
      return json(await service.getAvailableVariants(providerID, modelID));
    }

    if (action === "skills.list") {
      const service = await load<SkillsCatalogModule>("app/services/skills-catalog-service.js");
      return json(await service.loadSkillsCatalog(context.worktree));
    }

    if (action === "skills.create" || action === "skills.update") {
      const name = required(args.name, "name", action);
      const description = required(args.description, "description", action);
      const body = required(args.body, "body", action);
      const service = await load<SkillManageModule>("app/services/skill-manage-service.js");
      const location = action === "skills.create"
        ? await service.writeGlobalSkill({ name, description, body })
        : await service.updateGlobalSkill({ name, description, body });
      return json({ ok: true, name, location });
    }

    if (action === "skills.delete") {
      const name = required(args.name, "name", action);
      const service = await load<SkillManageModule>("app/services/skill-manage-service.js");
      return json({ ok: await service.deleteGlobalSkill(name), name });
    }

    if (action === "commands.list") {
      const service = await load<CommandCatalogModule>("app/services/command-catalog-service.js");
      return json(await service.loadCommandCatalog(context.worktree));
    }

    if (action.startsWith("mcp.")) {
      const service = await load<McpModule>("app/services/mcp-catalog-service.js");
      if (action === "mcp.list") return json(await service.loadMcpCatalog(context.worktree));
      const name = required(args.name, "name", action);
      if (action === "mcp.enable" || action === "mcp.disable") {
        await service.toggleMcpCatalogServer(context.worktree, name, action === "mcp.enable");
        return json({ ok: true, name, enabled: action === "mcp.enable" });
      }
      const value = required(args.value, "value", action);
      await service.addMcpCatalogServer({
        projectDirectory: context.worktree,
        name,
        type: action === "mcp.add-remote" ? "remote" : "local",
        value,
      });
      return json({ ok: true, name, type: action === "mcp.add-remote" ? "remote" : "local" });
    }

    if (action.startsWith("memory.")) {
      const service = await load<MemoryModule>("app/services/memory-service.js");
      if (action === "memory.list") {
        return json(await service.listMemories(args.scope as MemoryScope | undefined, args.project_id?.trim()));
      }
      if (action === "memory.search") {
        const query = required(args.query, "query", action);
        return json(await service.searchRelevantMemories({
          query,
          projectId: args.project_id?.trim(),
          projectDirectory: context.worktree,
          maxChars: args.max_chars,
        }));
      }
      if (action === "memory.add") {
        const scope = (args.scope ?? "user") as MemoryScope;
        const content = required(args.content, "content", action);
        return json(await service.addMemory({
          scope,
          content,
          projectId: args.project_id?.trim(),
          projectDirectory: scope === "project" ? context.worktree : undefined,
        }));
      }
      if (action === "memory.remove") {
        const id = required(args.id, "id", action);
        return json({ ok: await service.removeMemory(id), id });
      }
      return json({ ok: true, removed: await service.clearAllMemories() });
    }

    if (action === "providers.list" || action === "providers.get" || action === "providers.stt-status") {
      const service = await load<ProviderModule>("app/services/custom-provider-service.js");
      if (action === "providers.list") return json(await service.listCustomProviders());
      if (action === "providers.stt-status") return json({ configured: await service.isGroqSttConfigured() });
      const providerID = required(args.provider_id, "provider_id", action);
      return json((await service.getCustomProvider(providerID)) ?? null);
    }

    if (action === "version.info") {
      const service = await load<VersionModule>("app/services/version-info-service.js");
      return json(await service.getVersionSnapshot());
    }

    throw new Error(`Unsupported bot action: ${action}`);
  },
});
