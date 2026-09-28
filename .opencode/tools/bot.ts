import { randomUUID } from "node:crypto";
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
  "models.selection",
  "models.current",
  "models.refresh",
  "models.select",
  "agents.list",
  "agents.current",
  "agents.select",
  "variants.list",
  "variants.current",
  "variants.select",
  "skills.list",
  "skills.add",
  "skills.create",
  "skills.update",
  "skills.delete",
  "commands.list",
  "mcp.list",
  "mcp.add",
  "mcp.debug",
  "integrations.add",
  "extensions.list",
  "extensions.info",
  "extensions.ensure",
  "extensions.remove",
  "credentials.request",
  "credentials.status",
  "generated-actions.list",
  "generated-actions.toggle",
  "mcp.enable",
  "mcp.rename",
  "mcp.delete",
  "session.current",
  "session.messages",
  "session.latest-assistant",
  "run.status",
  "tasks.list",
  "tasks.get",
  "tasks.parse",
  "tasks.create",
  "tasks.delete",
  "settings.get",
  "settings.set",
  "memory.list",
  "memory.search",
  "memory.add",
  "memory.remove",
  "memory.clear",
  "providers.list",
  "providers.get",
  "providers.ensure",
  "providers.free-policy.get",
  "providers.free-policy.set",
  "providers.stt-status",
  "integrations.github.list",
  "integrations.github.active",
  "integrations.github.select",
  "integrations.github.remove",
  "version.info",
] as const;

const SETTINGS = [
  "compactOutputMode",
  "showThinkingContent",
  "responseStreamingMode",
  "messageFormatMode",
  "showAssistantRunFooter",
  "sendDiffFileAttachments",
  "promptQueueEnabled",
  "freeModelDetection",
] as const;

const DIST_ROOT = process.env.AGENT_BOT_DIST_ROOT?.trim() || "/app/dist";

type BotAction = (typeof BOT_ACTIONS)[number];
type SettingName = (typeof SETTINGS)[number];
type MemoryScope = "user" | "project";

type ModelInfo = { providerID: string; modelID: string; name?: string; variant?: string };
type ParsedSchedule =
  | { kind: "cron"; cron: string; timezone: string; summary: string; nextRunAt: string }
  | { kind: "once"; runAt: string; timezone: string; summary: string; nextRunAt: string };
type ScheduledTask = {
  id: string;
  projectId: string;
  projectWorktree: string;
  agent: string;
  model: { providerID: string; modelID: string; variant: string | null };
  scheduleText: string;
  scheduleSummary: string;
  timezone: string;
  prompt: string;
  createdAt: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  runCount: number;
  lastStatus: "idle" | "running" | "success" | "error";
  lastError: string | null;
} & ({ kind: "cron"; cron: string } | { kind: "once"; runAt: string });

interface ProjectModule {
  getProjects(): Promise<unknown[]>;
  getProjectByWorktree(worktree: string): Promise<{ id: string; worktree: string; name: string }>;
}
interface WorktreeModule { getGitWorktreeContext(worktree: string): Promise<unknown>; }
interface ModelModule {
  getProviders(): Promise<unknown[]>;
  getProviderModels(providerID: string): Promise<unknown[]>;
  searchModels(query: string): Promise<unknown[]>;
  getModelSelectionLists(): Promise<unknown>;
  refreshModelCatalog(): Promise<void>;
  resolveCatalogModel(providerID: string, modelID: string, options?: { forceRefresh?: boolean }): Promise<ModelInfo | null>;
  fetchCurrentModel(): ModelInfo;
  selectModel(modelInfo: ModelInfo): void;
  getStoredModel(): ModelInfo;
}
interface AgentModule {
  getAvailableAgents(): Promise<Array<{ name: string; description?: string; mode?: string; hidden?: boolean }>>;
  fetchCurrentAgent(): Promise<string>;
  selectAgent(agentName: string): void;
  getStoredAgent(): string;
}
interface VariantModule {
  getAvailableVariants(providerID: string, modelID: string): Promise<unknown[]>;
  getCurrentVariant(): string;
  validateVariantForModel(providerID: string, modelID: string, variantId: string): Promise<boolean>;
  setCurrentVariant(variantId: string): void;
}
interface SkillsCatalogModule { loadSkillsCatalog(projectDirectory: string): Promise<unknown[]>; }
interface SkillManageModule {
  writeGlobalSkill(input: { name: string; description: string; body: string }): Promise<string>;
  updateGlobalSkill(input: { name: string; description: string; body: string }): Promise<string>;
  writeGlobalSkillRaw(name: string, content: string): Promise<string>;
  deleteGlobalSkill(name: string): Promise<boolean>;
}
interface SkillImportModule {
  resolveSkillSource(url: string): Promise<
    | { kind: "single"; skill: { name: string; description: string; content: string; sourceUrl: string } }
    | { kind: "list"; candidates: Array<{ name: string; url: string }> }
  >;
}
interface CommandCatalogModule { loadCommandCatalog(projectDirectory: string): Promise<unknown[]>; }
interface McpModule {
  loadMcpServers(projectDirectory: string): Promise<unknown[]>;
  debugMcpServer(projectDirectory: string, serverName?: string, options?: { repair?: boolean }): Promise<unknown>;
  createMcpServerFromInput(options: { projectDirectory: string; name: string; type: "local" | "remote"; value: string }): Promise<void>;
  setMcpServerEnabled(projectDirectory: string, serverName: string, enable: boolean): Promise<void>;
  renameMcpServer(projectDirectory: string, serverName: string, newName: string): Promise<unknown>;
  deleteMcpServer(projectDirectory: string, serverName: string): Promise<{ deleted: boolean; name: string }>;
}
interface SessionModule {
  getEffectiveCurrentSession(): Promise<{ id: string; title: string; directory: string } | null>;
}
interface MessageModule {
  loadUserMessages(sessionId: string, directory: string): Promise<unknown[]>;
  loadLatestAssistantResponse(sessionId: string, directory: string): Promise<string | null>;
}
interface RunModule { isForegroundBusy(): boolean; reconcileForegroundBusyState(): Promise<void>; }
interface TaskParserModule { parseTaskSchedule(scheduleText: string, directory: string): Promise<ParsedSchedule>; }
interface TaskStoreModule {
  listScheduledTasks(): ScheduledTask[];
  getScheduledTask(taskId: string): ScheduledTask | null;
  addScheduledTask(task: ScheduledTask): Promise<void>;
  removeScheduledTask(taskId: string): Promise<boolean>;
}
interface TaskRuntimeModule {
  scheduledTaskRuntime: { registerTask(task: ScheduledTask): void; removeTask(taskId: string): void };
}
interface SettingsModule {
  getCompactOutputMode(): boolean;
  setCompactOutputMode(enabled: boolean): void;
  getShowThinkingContent(): boolean;
  setShowThinkingContent(enabled: boolean): void;
  getResponseStreamingMode(): "edit" | "draft";
  setResponseStreamingMode(mode: "edit" | "draft"): void;
  getMessageFormatMode(): "raw" | "markdown";
  setMessageFormatMode(mode: "raw" | "markdown"): void;
  getShowAssistantRunFooter(): boolean;
  setShowAssistantRunFooter(enabled: boolean): void;
  getSendDiffFileAttachments(): boolean;
  setSendDiffFileAttachments(enabled: boolean): void;
  getPromptQueueEnabled(): boolean;
  setPromptQueueEnabled(enabled: boolean): void;
  getFreeModelDetectionEnabled(): boolean;
  setFreeModelDetectionEnabled(enabled: boolean): Promise<void>;
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
interface GithubIntegrationModule {
  listGithubAccounts(): Promise<unknown[]>;
  getActiveGithubAccount(): Promise<unknown>;
  setActiveGithubAccount(id: string): Promise<unknown>;
  removeGithubAccount(id: string): Promise<boolean>;
}
interface ExtensionRegistryModule {
  listExtensions(projectDirectory: string): Promise<unknown[]>;
  getExtensionInfo(projectDirectory: string, id: string): Promise<unknown>;
  removeExtension(projectDirectory: string, id: string): Promise<unknown>;
}
interface ExtensionEnsureModule {
  requestExtensionEnsure(input: { sessionId: string; projectDirectory: string; name: string; kind: "model-provider" | "plugin"; source: string; purpose: string; authType?: "none" | "api-key" }): Promise<unknown>;
  addSkillExtension(input: { sessionId: string; projectDirectory: string; source: string; confirmed?: boolean }): Promise<unknown>;
  addMcpBackedExtension(input: {
    sessionId: string;
    projectDirectory: string;
    name: string;
    source: string;
    purpose: string;
    kind: "mcp" | "integration";
    confirmed?: boolean;
    authType?: "none" | "oauth" | "api-key" | "bearer";
  }): Promise<unknown>;
}
interface CredentialModule {
  createSecureCredentialChallenge(input: { extensionId: string; credentialId: string; sessionId: string; projectDirectory: string }): Promise<unknown>;
}
interface CredentialVaultModule {
  getExtensionCredentialStatus(extensionId: string, credentialId: string): Promise<unknown>;
}
interface GeneratedActionsModule {
  listGeneratedActions(extensionId?: string): Promise<unknown[]>;
  registerGeneratedActionPack(extensionId: string, actions: Array<{ id: string; tool: string; action?: string; category?: string; description: string }>): Promise<unknown[]>;
  setGeneratedActionEnabled(id: string, enabled: boolean): Promise<unknown>;
}
interface ProviderFreePolicyModule {
  getProviderFreePolicy(providerId: string): Promise<unknown>;
  setProviderFreePolicy(input: { providerId: string; freeSuffix?: string; freeModels: string[]; paidByDefault: boolean; confidence: "low" | "medium" | "high"; source?: string }): Promise<unknown>;
}
interface VersionModule { getVersionSnapshot(): Promise<unknown>; }

interface ConfigModule { config: { bot: { taskLimit: number } }; }

async function load<T>(relativePath: string): Promise<T> {
  return import(pathToFileURL(path.join(DIST_ROOT, relativePath)).href) as Promise<T>;
}

function required(value: string | undefined, field: string, action: BotAction): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${action} requires ${field}`);
  return normalized;
}

function json(value: unknown): string { return JSON.stringify(value, null, 2).slice(0, 30000); }

function modelSafeExtensionAddResult(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = value as Record<string, unknown>;
  const status = typeof result.status === "string" ? result.status : "";
  if (status !== "awaiting-oauth" && status !== "awaiting-credential") return value;

  const extension = result.extension && typeof result.extension === "object"
    ? result.extension as Record<string, unknown>
    : {};
  return {
    status,
    extension: {
      id: extension.id,
      name: extension.name,
      kind: extension.kind,
    },
    telegramUi: status === "awaiting-oauth"
      ? "A Sign in button is being presented to the user in Telegram. Do not print or request the OAuth URL/code."
      : "A secure credential input is being presented to the user in Telegram. Do not ask for or repeat the secret.",
  };
}

function expandMinuteBase(base: string): number[] {
  if (base === "*") return Array.from({ length: 60 }, (_, index) => index);
  if (base.includes("-")) {
    const [rawStart, rawEnd] = base.split("-");
    const start = Number(rawStart), end = Number(rawEnd);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 59 || start > end) throw new Error("Invalid cron minute range");
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  }
  const value = Number(base);
  if (!Number.isInteger(value) || value < 0 || value > 59) throw new Error("Invalid cron minute value");
  return [value];
}

function expandMinuteField(field: string): number[] {
  const values = new Set<number>();
  for (const token of field.split(",")) {
    const [base, rawStep] = token.trim().split("/");
    if (!base) throw new Error("Invalid cron minute field");
    const baseValues = expandMinuteBase(base);
    const step = rawStep === undefined ? 1 : Number(rawStep);
    if (!Number.isInteger(step) || step <= 0) throw new Error("Invalid cron minute step");
    baseValues.filter((_value, index) => index % step === 0).forEach((value) => values.add(value));
  }
  return [...values].sort((left, right) => left - right);
}

function validateScheduleFrequency(schedule: ParsedSchedule): void {
  if (schedule.kind !== "cron") return;
  const minuteField = schedule.cron.trim().split(/\s+/)[0];
  if (!minuteField) throw new Error("Invalid cron expression");
  const values = expandMinuteField(minuteField);
  if (values.length <= 1) return;
  let minGap = 60;
  for (let index = 0; index < values.length; index += 1) {
    const current = values[index]!;
    const nextRaw = values[(index + 1) % values.length]!;
    const next = index === values.length - 1 ? nextRaw + 60 : nextRaw;
    minGap = Math.min(minGap, next - current);
  }
  if (minGap < 5) throw new Error("Scheduled tasks cannot run more frequently than every 5 minutes.");
}

function buildTask(input: {
  projectId: string;
  worktree: string;
  agent: string;
  model: ModelInfo;
  scheduleText: string;
  schedule: ParsedSchedule;
  prompt: string;
}): ScheduledTask {
  const base = {
    id: randomUUID(),
    projectId: input.projectId,
    projectWorktree: input.worktree,
    agent: input.agent,
    model: { providerID: input.model.providerID, modelID: input.model.modelID, variant: input.model.variant ?? null },
    scheduleText: input.scheduleText,
    scheduleSummary: input.schedule.summary,
    timezone: input.schedule.timezone,
    prompt: input.prompt,
    createdAt: new Date().toISOString(),
    nextRunAt: input.schedule.nextRunAt,
    lastRunAt: null,
    runCount: 0,
    lastStatus: "idle" as const,
    lastError: null,
  };
  return input.schedule.kind === "cron"
    ? { ...base, kind: "cron", cron: input.schedule.cron }
    : { ...base, kind: "once", runAt: input.schedule.runAt };
}

async function readSettings(): Promise<Record<SettingName, unknown>> {
  const service = await load<SettingsModule>("app/stores/settings-store.js");
  return {
    compactOutputMode: service.getCompactOutputMode(),
    showThinkingContent: service.getShowThinkingContent(),
    responseStreamingMode: service.getResponseStreamingMode(),
    messageFormatMode: service.getMessageFormatMode(),
    showAssistantRunFooter: service.getShowAssistantRunFooter(),
    sendDiffFileAttachments: service.getSendDiffFileAttachments(),
    promptQueueEnabled: service.getPromptQueueEnabled(),
    freeModelDetection: service.getFreeModelDetectionEnabled(),
  };
}

export default tool({
  description:
    "Access the bot control plane through explicit model-facing actions. Skills and plugins can use the managed install flow. MCP servers and dynamic Integrations are always user-directed: call mcp.add / integrations.add once to analyze the endpoint and return a native Question with explicit auth choices (OAuth / API key / Bearer / no auth / cancel). Never infer or auto-select an MCP auth mode. After the user chooses, the bot resumes that exact selected path. OAuth may finish either by the user pasting a localhost callback URL or by tapping Check after browser sign-in. API keys/tokens use Telegram secure input and are verified before activation. No permission request is needed. Extension installation/update is bot-owned runtime configuration; never edit, commit, push, or deploy project/repository files merely to install an Extension. Secrets are never returned or accepted here.",
  args: {
    action: tool.schema.enum(BOT_ACTIONS).describe("Bot capability action to execute."),
    provider_id: tool.schema.string().optional().describe("Provider ID for model/provider actions."),
    model_id: tool.schema.string().optional().describe("Model ID for model/variant actions."),
    variant: tool.schema.string().optional().describe("Model variant for selection actions."),
    agent: tool.schema.string().optional().describe("Agent name for agents.select."),
    query: tool.schema.string().optional().describe("Search query for model or memory search."),
    name: tool.schema.string().optional().describe("Skill, MCP, Extension, or generated-action name."),
    description: tool.schema.string().optional().describe("Skill description or concise reason/purpose for an Extension."),
    body: tool.schema.string().optional().describe("Skill body or JSON payload for generated actions/provider free-policy."),
    value: tool.schema.string().optional().describe("Extension source URL/specifier, version-pinned OpenCode plugin specifier, MCP URL/command, rename target, or settings value."),
    extension_id: tool.schema.string().optional().describe("Registered Extension ID."),
    credential_id: tool.schema.string().optional().describe("Credential schema ID registered by an Extension. Never pass a secret value."),
    extension_kind: tool.schema.enum(["plugin"]).optional().describe("extensions.ensure is reserved for OpenCode plugins. Use providers.ensure, mcp.add, skills.add, or integrations.add for all other Extension classes."),
    auth_type: tool.schema.enum(["none", "oauth", "api-key", "bearer"]).optional().describe("Internal/manual Extension auth selection. MCP/Integration callers must not infer this value; the user chooses it through the returned Question flow. Raw secrets are never accepted."),
    confidence: tool.schema.enum(["low", "medium", "high"]).optional().describe("Provider-level free-model policy confidence."),
    paid_by_default: tool.schema.boolean().optional().describe("Provider free-policy fallback when a model is not explicitly listed."),
    free_suffix: tool.schema.string().optional().describe("Provider-advertised free model suffix, such as :free."),
    source_url: tool.schema.string().optional().describe("Public provider policy/docs source URL."),
    scope: tool.schema.enum(["user", "project"]).optional().describe("Memory scope; defaults to user."),
    content: tool.schema.string().optional().describe("Memory content for memory.add."),
    id: tool.schema.string().optional().describe("Memory, task, or integration account ID."),
    project_id: tool.schema.string().optional().describe("Optional project ID for project-scoped memory."),
    max_chars: tool.schema.number().optional().describe("Optional memory-search result character budget."),
    schedule: tool.schema.string().optional().describe("Natural-language schedule for tasks.parse/tasks.create."),
    prompt: tool.schema.string().optional().describe("Scheduled-task prompt for tasks.create."),
    setting: tool.schema.enum(SETTINGS).optional().describe("Safe bot setting for settings.get/settings.set."),
    enabled: tool.schema.boolean().optional().describe("Boolean value for boolean settings."),
    repair: tool.schema.boolean().optional().describe("For mcp.debug, force-resync managed MCP definitions into the current Topic runtime before returning diagnostics."),
  },
  async execute(args, context) {
    const action = args.action as BotAction;
    const base = context.directory || context.worktree || process.cwd();

    if (action === "capabilities.list") {
      return json({ actions: BOT_ACTIONS, settings: SETTINGS, notes: {
        secretConfiguration: "API keys/tokens remain Telegram-UI-only; this tool never accepts or returns credentials.",
        media: "Use the media tool for STT and configured image generation/editing.",
        sessionRecovery: "Use session-recovery for inspect/abort/continue.",
        dynamicMcpTools: "Connected MCP servers expose their model tools directly through OpenCode.",
        extensionStorage: "Extension setup is bot-owned runtime configuration. Use extensions.ensure/remove; never edit opencode.json, package files, .opencode, commit, push, or deploy merely to install/update an Extension.",
      } });
    }

    if (action === "projects.list") {
      const service = await load<ProjectModule>("app/services/project-service.js");
      return json(await service.getProjects());
    }
    if (action === "worktree.context") {
      const service = await load<WorktreeModule>("app/services/worktree-service.js");
      return json(await service.getGitWorktreeContext(base));
    }

    if (action.startsWith("models.")) {
      const service = await load<ModelModule>("app/services/model-selection-service.js");
      if (action === "models.providers") return json(await service.getProviders());
      if (action === "models.list") return json(await service.getProviderModels(required(args.provider_id, "provider_id", action)));
      if (action === "models.search") return json(await service.searchModels(required(args.query, "query", action)));
      if (action === "models.selection") return json(await service.getModelSelectionLists());
      if (action === "models.current") return json(service.fetchCurrentModel());
      if (action === "models.refresh") { await service.refreshModelCatalog(); return json({ ok: true, refreshed: true }); }
      const providerID = required(args.provider_id, "provider_id", action);
      const modelID = required(args.model_id, "model_id", action);
      const model = await service.resolveCatalogModel(providerID, modelID, { forceRefresh: false });
      if (!model) throw new Error(`Model not found in the live catalog: ${providerID}/${modelID}`);
      const requestedVariant = args.variant?.trim();
      if (requestedVariant && requestedVariant !== "default") {
        const variants = await load<VariantModule>("app/services/variant-selection-service.js");
        if (!(await variants.validateVariantForModel(providerID, modelID, requestedVariant))) throw new Error(`Unsupported variant ${requestedVariant} for ${providerID}/${modelID}`);
      }
      service.selectModel({ ...model, variant: requestedVariant || "default" });
      return json({ ok: true, model: service.fetchCurrentModel() });
    }

    if (action.startsWith("agents.")) {
      const service = await load<AgentModule>("app/services/agent-selection-service.js");
      if (action === "agents.list") {
        // The raw agent objects embed the full permission rule arrays, which
        // are large and useless for tool callers. Return the compact shape.
        const agents = await service.getAvailableAgents();
        return json(agents.map((agent) => ({
          name: agent.name,
          description: agent.description,
          mode: agent.mode,
          native: agent.native,
        })));
      }
      if (action === "agents.current") return json({ agent: await service.fetchCurrentAgent() });
      const name = required(args.agent, "agent", action);
      const agents = await service.getAvailableAgents();
      if (!agents.some((item) => item.name === name)) throw new Error(`Unknown or unavailable agent: ${name}`);
      service.selectAgent(name);
      return json({ ok: true, agent: name });
    }

    if (action.startsWith("variants.")) {
      const service = await load<VariantModule>("app/services/variant-selection-service.js");
      if (action === "variants.list") return json(await service.getAvailableVariants(required(args.provider_id, "provider_id", action), required(args.model_id, "model_id", action)));
      if (action === "variants.current") return json({ variant: service.getCurrentVariant() });
      const variant = required(args.variant, "variant", action);
      const models = await load<ModelModule>("app/services/model-selection-service.js");
      const current = models.getStoredModel();
      if (!current.providerID || !current.modelID) throw new Error("No current model is selected.");
      if (variant !== "default" && !(await service.validateVariantForModel(current.providerID, current.modelID, variant))) throw new Error(`Unsupported variant ${variant} for ${current.providerID}/${current.modelID}`);
      service.setCurrentVariant(variant);
      return json({ ok: true, variant });
    }

    if (action.startsWith("skills.")) {
      const catalog = await load<SkillsCatalogModule>("app/services/skills-catalog-service.js");
      if (action === "skills.list") return json(await catalog.loadSkillsCatalog(base));
      if (action === "skills.add") {
        const ensure = await load<ExtensionEnsureModule>("app/services/extension-ensure-service.js");
        return json(await ensure.addSkillExtension({
          sessionId: context.sessionID,
          projectDirectory: base,
          source: required(args.value, "value", action),
        }));
      }
      const manager = await load<SkillManageModule>("app/services/skill-manage-service.js");
      if (action === "skills.delete") {
        const name = required(args.name, "name", action);
        return json({ ok: await manager.deleteGlobalSkill(name), name });
      }
      const name = required(args.name, "name", action);
      const description = required(args.description, "description", action);
      const body = required(args.body, "body", action);
      const location = action === "skills.create"
        ? await manager.writeGlobalSkill({ name, description, body })
        : await manager.updateGlobalSkill({ name, description, body });
      return json({ ok: true, name, location });
    }

    if (action === "commands.list") {
      const service = await load<CommandCatalogModule>("app/services/command-catalog-service.js");
      return json(await service.loadCommandCatalog(base));
    }

    if (action.startsWith("mcp.")) {
      const service = await load<McpModule>("app/services/mcp-server-service.js");
      if (action === "mcp.list") return json(await service.loadMcpServers(base));
      if (action === "mcp.add") {
        const ensure = await load<ExtensionEnsureModule>("app/services/extension-ensure-service.js");
        return json(modelSafeExtensionAddResult(await ensure.addMcpBackedExtension({
          sessionId: context.sessionID,
          projectDirectory: base,
          name: required(args.name, "name", action),
          kind: "mcp",
          source: required(args.value, "value", action),
          purpose: required(args.description, "description", action),
        })));
      }
      if (action === "mcp.debug") {
        return json(await service.debugMcpServer(base, args.name, { repair: args.repair === true }));
      }
      const name = required(args.name, "name", action);
      if (action === "mcp.enable") {
        await service.setMcpServerEnabled(base, name, true);
        return json({ ok: true, name, enabled: true });
      }
      if (action === "mcp.delete") {
        return json(await service.deleteMcpServer(base, name));
      }
      if (action === "mcp.rename") {
        const newName = required(args.value, "value", action);
        return json({ ok: true, server: await service.renameMcpServer(base, name, newName) });
      }
      throw new Error(`Unsupported MCP action: ${action}`);
    }

    if (action === "integrations.add") {
      const ensure = await load<ExtensionEnsureModule>("app/services/extension-ensure-service.js");
      return json(modelSafeExtensionAddResult(await ensure.addMcpBackedExtension({
        sessionId: context.sessionID,
        projectDirectory: base,
        name: required(args.name, "name", action),
        kind: "integration",
        source: required(args.value, "value", action),
        purpose: required(args.description, "description", action),
      })));
    }

    if (action.startsWith("extensions.")) {
      const registry = await load<ExtensionRegistryModule>("app/services/extension-registry-service.js");
      if (action === "extensions.list") return json(await registry.listExtensions(base));
      if (action === "extensions.info") return json(await registry.getExtensionInfo(base, required(args.extension_id, "extension_id", action)));
      if (action === "extensions.remove") return json(await registry.removeExtension(base, required(args.extension_id, "extension_id", action)));
      const kind = "plugin" as const;
      const ensure = await load<ExtensionEnsureModule>("app/services/extension-ensure-service.js");
      return json(await ensure.requestExtensionEnsure({
        sessionId: context.sessionID,
        projectDirectory: base,
        name: required(args.name, "name", action),
        kind,
        source: required(args.value, "value", action),
        purpose: required(args.description, "description", action),
        authType: args.auth_type ?? "none",
      }));
    }

    if (action.startsWith("credentials.")) {
      const extensionId = required(args.extension_id, "extension_id", action);
      const credentialId = required(args.credential_id, "credential_id", action);
      if (action === "credentials.status") {
        const vault = await load<CredentialVaultModule>("app/services/credential-vault-service.js");
        return json({ extensionId, credentialId, status: await vault.getExtensionCredentialStatus(extensionId, credentialId) });
      }
      const broker = await load<CredentialModule>("app/services/secure-credential-broker.js");
      return json(await broker.createSecureCredentialChallenge({
        extensionId,
        credentialId,
        sessionId: context.sessionID,
        projectDirectory: base,
      }));
    }

    if (action.startsWith("generated-actions.")) {
      const generated = await load<GeneratedActionsModule>("app/services/generated-action-store.js");
      const extensionId = args.extension_id?.trim();
      if (action === "generated-actions.list") return json(await generated.listGeneratedActions(extensionId));
      if (action === "generated-actions.toggle") {
        const id = required(args.id, "id", action);
        if (typeof args.enabled !== "boolean") throw new Error("generated-actions.toggle requires enabled=true|false");
        return json(await generated.setGeneratedActionEnabled(id, args.enabled));
      }
      throw new Error(`Unsupported generated-actions operation: ${action}. Action packs are generated automatically by the bot.`);
    }

    if (action.startsWith("session.")) {
      const sessionService = await load<SessionModule>("app/services/session-service.js");
      const session = await sessionService.getEffectiveCurrentSession();
      if (action === "session.current") return json(session);
      if (!session) throw new Error("No current session is available in this context.");
      const messages = await load<MessageModule>("app/services/message-history-service.js");
      if (action === "session.messages") return json(await messages.loadUserMessages(session.id, session.directory));
      return json({ text: await messages.loadLatestAssistantResponse(session.id, session.directory) });
    }

    if (action === "run.status") {
      const service = await load<RunModule>("app/services/run-control-service.js");
      await service.reconcileForegroundBusyState();
      return json({ busy: service.isForegroundBusy() });
    }

    if (action.startsWith("tasks.")) {
      const store = await load<TaskStoreModule>("app/stores/scheduled-task-store.js");
      if (action === "tasks.list") return json(store.listScheduledTasks());
      if (action === "tasks.get") return json(store.getScheduledTask(required(args.id, "id", action)));
      if (action === "tasks.delete") {
        const id = required(args.id, "id", action);
        const removed = await store.removeScheduledTask(id);
        if (removed) (await load<TaskRuntimeModule>("app/services/scheduled-task-runtime-service.js")).scheduledTaskRuntime.removeTask(id);
        return json({ ok: removed, id });
      }
      const scheduleText = required(args.schedule, "schedule", action);
      const parser = await load<TaskParserModule>("app/services/scheduled-task-schedule-parser-service.js");
      const parsed = await parser.parseTaskSchedule(scheduleText, base);
      validateScheduleFrequency(parsed);
      if (action === "tasks.parse") return json(parsed);
      const prompt = required(args.prompt, "prompt", action);
      const configModule = await load<ConfigModule>("config.js");
      if (store.listScheduledTasks().length >= configModule.config.bot.taskLimit) throw new Error(`Scheduled-task limit reached (${configModule.config.bot.taskLimit}).`);
      const projects = await load<ProjectModule>("app/services/project-service.js");
      let projectId = `worktree:${base}`;
      try { projectId = (await projects.getProjectByWorktree(base)).id; } catch { /* worktree is still a valid execution target */ }
      const models = await load<ModelModule>("app/services/model-selection-service.js");
      const agents = await load<AgentModule>("app/services/agent-selection-service.js");
      const task = buildTask({ projectId, worktree: base, agent: agents.getStoredAgent(), model: models.getStoredModel(), scheduleText, schedule: parsed, prompt });
      await store.addScheduledTask(task);
      (await load<TaskRuntimeModule>("app/services/scheduled-task-runtime-service.js")).scheduledTaskRuntime.registerTask(task);
      return json({ ok: true, task });
    }

    if (action.startsWith("settings.")) {
      const current = await readSettings();
      if (action === "settings.get") {
        const setting = args.setting as SettingName | undefined;
        return json(setting ? { setting, value: current[setting] } : current);
      }
      const setting = args.setting as SettingName | undefined;
      if (!setting) throw new Error("settings.set requires setting");
      const service = await load<SettingsModule>("app/stores/settings-store.js");
      if (["compactOutputMode", "showThinkingContent", "showAssistantRunFooter", "sendDiffFileAttachments", "promptQueueEnabled", "freeModelDetection"].includes(setting)) {
        if (typeof args.enabled !== "boolean") throw new Error(`${setting} requires enabled=true|false`);
        if (setting === "compactOutputMode") service.setCompactOutputMode(args.enabled);
        else if (setting === "showThinkingContent") service.setShowThinkingContent(args.enabled);
        else if (setting === "showAssistantRunFooter") service.setShowAssistantRunFooter(args.enabled);
        else if (setting === "sendDiffFileAttachments") service.setSendDiffFileAttachments(args.enabled);
        else if (setting === "promptQueueEnabled") service.setPromptQueueEnabled(args.enabled);
        else await service.setFreeModelDetectionEnabled(args.enabled);
      } else if (setting === "responseStreamingMode") {
        if (args.value !== "edit" && args.value !== "draft") throw new Error("responseStreamingMode requires value=edit|draft");
        service.setResponseStreamingMode(args.value);
      } else {
        if (args.value !== "raw" && args.value !== "markdown") throw new Error("messageFormatMode requires value=raw|markdown");
        service.setMessageFormatMode(args.value);
      }
      const next = await readSettings();
      return json({ ok: true, setting, value: next[setting] });
    }

    if (action.startsWith("memory.")) {
      const service = await load<MemoryModule>("app/services/memory-service.js");
      if (action === "memory.list") return json(await service.listMemories(args.scope as MemoryScope | undefined, args.project_id?.trim()));
      if (action === "memory.search") return json(await service.searchRelevantMemories({ query: required(args.query, "query", action), projectId: args.project_id?.trim(), projectDirectory: base, maxChars: args.max_chars }));
      if (action === "memory.add") {
        const scope = (args.scope ?? "user") as MemoryScope;
        return json(await service.addMemory({ scope, content: required(args.content, "content", action), projectId: args.project_id?.trim(), projectDirectory: scope === "project" ? base : undefined }));
      }
      if (action === "memory.remove") { const id = required(args.id, "id", action); return json({ ok: await service.removeMemory(id), id }); }
      return json({ ok: true, removed: await service.clearAllMemories() });
    }

    if (action.startsWith("providers.")) {
      const service = await load<ProviderModule>("app/services/custom-provider-service.js");
      if (action === "providers.list") return json(await service.listCustomProviders());
      if (action === "providers.stt-status") return json({ configured: await service.isGroqSttConfigured() });
      if (action === "providers.ensure") {
        const ensure = await load<ExtensionEnsureModule>("app/services/extension-ensure-service.js");
        return json(await ensure.requestExtensionEnsure({
          sessionId: context.sessionID,
          projectDirectory: base,
          name: required(args.name, "name", action),
          kind: "model-provider",
          source: required(args.value, "value", action),
          purpose: required(args.description, "description", action),
          authType: "api-key",
        }));
      }
      if (action === "providers.free-policy.get") {
        const policy = await load<ProviderFreePolicyModule>("app/services/provider-free-policy-service.js");
        return json(await policy.getProviderFreePolicy(required(args.provider_id, "provider_id", action)));
      }
      if (action === "providers.free-policy.set") {
        const policy = await load<ProviderFreePolicyModule>("app/services/provider-free-policy-service.js");
        const providerId = required(args.provider_id, "provider_id", action);
        const freeModels = args.body?.trim() ? JSON.parse(args.body) as unknown : [];
        if (!Array.isArray(freeModels) || !freeModels.every((item) => typeof item === "string")) throw new Error("providers.free-policy.set body must be a JSON array of model IDs.");
        if (typeof args.paid_by_default !== "boolean" || !args.confidence) throw new Error("providers.free-policy.set requires paid_by_default and confidence.");
        return json(await policy.setProviderFreePolicy({
          providerId,
          freeModels,
          paidByDefault: args.paid_by_default,
          confidence: args.confidence,
          ...(args.free_suffix?.trim() ? { freeSuffix: args.free_suffix.trim() } : {}),
          ...(args.source_url?.trim() ? { source: args.source_url.trim() } : {}),
        }));
      }
      return json((await service.getCustomProvider(required(args.provider_id, "provider_id", action))) ?? null);
    }

    if (action.startsWith("integrations.github.")) {
      const service = await load<GithubIntegrationModule>("app/services/github-integration-service.js");
      if (action === "integrations.github.list") return json(await service.listGithubAccounts());
      if (action === "integrations.github.active") return json(await service.getActiveGithubAccount());
      const id = required(args.id, "id", action);
      if (action === "integrations.github.select") return json({ ok: true, account: await service.setActiveGithubAccount(id) });
      return json({ ok: await service.removeGithubAccount(id), id });
    }

    if (action === "version.info") {
      const service = await load<VersionModule>("app/services/version-info-service.js");
      return json(await service.getVersionSnapshot());
    }

    throw new Error(`Unsupported bot action: ${action}`);
  },
});