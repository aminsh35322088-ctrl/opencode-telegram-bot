import { listGeneratedActions } from "./generated-action-store.js";

export const AGENT_ACTION_SOURCES = ["opencode-core", "custom-tool", "plugin", "dynamic-mcp", "generated-extension"] as const;
export type AgentActionSource = (typeof AGENT_ACTION_SOURCES)[number];

export const AGENT_ACTION_RISKS = ["read", "write", "external", "mutating", "destructive"] as const;
export type AgentActionRisk = (typeof AGENT_ACTION_RISKS)[number];

export interface AgentActionInvocation {
  kind: "native-tool" | "action-tool" | "mcp-tool";
  tool: string;
  actionArgument?: string;
  actionValue?: string;
  arguments?: Record<string, string>;
}

export interface AgentActionDefinition {
  id: string;
  tool: string;
  action: string;
  source: AgentActionSource;
  category: string;
  risk: AgentActionRisk;
  description: string;
  invocation: AgentActionInvocation;
}

export interface AgentActionFilters {
  tool?: string;
  category?: string;
  source?: AgentActionSource;
  risk?: AgentActionRisk;
  query?: string;
}

export const CORE_TOOL_ACTIONS = {
  bash: ["exec"], read: ["read"], write: ["write"], edit: ["edit"], apply_patch: ["apply"],
  grep: ["search"], glob: ["search"], webfetch: ["fetch"], websearch: ["search"], lsp: ["query"],
  todowrite: ["update"], task: ["delegate"], question: ["ask"], skill: ["load"],
} as const;

export const CUSTOM_TOOL_ACTIONS = {
  actions: ["list", "describe", "resolve", "sources", "summary"],
  bot: [
    "capabilities.list", "projects.list", "worktree.context",
    "models.providers", "models.list", "models.search", "models.selection", "models.current", "models.refresh", "models.select",
    "agents.list", "agents.current", "agents.select",
    "variants.list", "variants.current", "variants.select",
    "skills.list", "skills.add", "skills.create", "skills.update", "skills.delete", "commands.list",
    "mcp.list", "mcp.add", "mcp.debug", "mcp.enable", "mcp.rename", "mcp.delete",
    "integrations.add",
    "extensions.list", "extensions.info", "extensions.ensure", "extensions.remove",
    "credentials.request", "credentials.status",
    "generated-actions.list", "generated-actions.register", "generated-actions.toggle",
    "session.current", "session.messages", "session.latest-assistant", "run.status",
    "tasks.list", "tasks.get", "tasks.parse", "tasks.create", "tasks.delete",
    "settings.get", "settings.set",
    "memory.list", "memory.search", "memory.add", "memory.remove", "memory.clear",
    "providers.list", "providers.get", "providers.ensure", "providers.free-policy.get", "providers.free-policy.set", "providers.stt-status",
    "integrations.github.list", "integrations.github.active", "integrations.github.select", "integrations.github.remove",
    "version.info",
  ],
  file: ["read", "write", "search", "grep", "info", "delete", "copy", "move"],
  git: ["status", "diff", "log", "commit", "push", "pull", "branch", "checkout", "stash", "merge", "rebase", "blame", "tags", "remote", "fetch", "reset"],
  monitoring: ["tail", "grep", "health", "metrics", "alerts"],
  notify: ["send", "alert", "schedule", "list", "cancel"],
  security: ["secrets", "audit", "permissions", "deps"],
  "session-extended": ["create", "delete", "export", "list-all", "archive"],
  test: ["test", "lint", "typecheck", "build", "test-file", "lint-fix"],
  browser: [
    "open", "goto", "back", "forward", "reload", "snapshot", "screenshot", "click", "fill", "type", "press",
    "hover", "check", "uncheck", "select", "close", "tab-list", "tab-new", "tab-select", "tab-close", "requests", "console", "pdf",
  ],
  "database-query": ["query"],
  "full-diagnostics": ["quick", "full"],
  "github-ci": ["status", "jobs", "dispatch", "watch", "logs", "verify", "rerun-failed", "cancel"],
  "image-inspect": ["inspect"],
  "logs-observability": ["search"],
  media: ["stt.status", "stt.transcribe", "video.prepare", "image.providers", "image.models", "image.current", "image.generate", "image.edit"],
  telegram: ["context.current", "reply.resolve", "forward.inspect", "media.fetch"],
  "network-diagnostics": ["dns", "http", "tcp"],
  tailscale: ["status", "devices", "ping", "ssh-public-key"],
  ssh: ["check", "debug", "exec", "upload", "download"],
  "safe-download": ["download"],
  "send-file": ["send"],
  session: ["current", "messages", "latest-assistant", "fork", "revert", "unrevert", "summarize", "abort", "diff", "todo", "children"],
  "session-recovery": ["inspect", "abort", "continue"],
  "storage-health": ["inspect", "cleanup-safe"],
  "system-diagnostics": ["summary", "processes", "disk"],
} as const;

type CoreToolName = keyof typeof CORE_TOOL_ACTIONS;
type CustomToolName = keyof typeof CUSTOM_TOOL_ACTIONS;

const CORE_CATEGORIES: Record<CoreToolName, string> = {
  bash: "shell", read: "filesystem", write: "filesystem", edit: "filesystem", apply_patch: "filesystem",
  grep: "filesystem", glob: "filesystem", webfetch: "web", websearch: "web", lsp: "code-intelligence",
  todowrite: "agent-workflow", task: "agent-workflow", question: "agent-workflow", skill: "agent-workflow",
};

const CUSTOM_CATEGORIES: Record<CustomToolName, string> = {
  actions: "discovery", bot: "bot-control", file: "filesystem", git: "version-control", monitoring: "observability",
  notify: "notification", security: "security", "session-extended": "session", test: "ci", browser: "browser", "database-query": "database",
  "full-diagnostics": "diagnostics", "github-ci": "ci", "image-inspect": "media", "logs-observability": "observability",
  media: "media", telegram: "telegram-context", "network-diagnostics": "network", tailscale: "remote-access", ssh: "remote-access",
  "safe-download": "transfer", "send-file": "transfer", session: "session", "session-recovery": "session", "storage-health": "storage",
  "system-diagnostics": "diagnostics",
};

const DESCRIPTIONS: Record<string, string> = {
  "bash.exec": "Execute a shell command with OpenCode's native bash tool.",
  "read.read": "Read file content.",
  "write.write": "Create or replace file content.",
  "edit.edit": "Apply a targeted text edit.",
  "apply_patch.apply": "Apply a structured patch.",
  "webfetch.fetch": "Fetch a web resource.",
  "websearch.search": "Search the public web.",
  "skill.load": "Load an installed OpenCode skill.",
  "bot.capabilities.list": "List the bot control-plane actions available to the model.",
  "bot.models.select": "Select a verified model and optional variant.",
  "bot.agents.select": "Select an available OpenCode agent.",
  "bot.variants.select": "Select a validated variant for the current model.",
  "bot.tasks.create": "Create and register a scheduled task using the current worktree, model, and agent.",
  "bot.settings.set": "Update a constrained safe bot setting.",
  "bot.mcp.add": "Analyze a remote/local MCP source, return a Question-tool preview, and add it after explicit conversational confirmation. OAuth/API-key follow-up is handled by the bot.",
  "bot.skills.add": "Analyze a skill source, return a Question-tool preview, and import it after conversational confirmation.",
  "bot.integrations.add": "Analyze and add an MCP-backed service integration after Question-tool confirmation, then register it as an Extension.",
  "bot.mcp.debug": "Inspect and optionally repair MCP runtime synchronization without exposing credentials.",
  "media.stt.transcribe": "Transcribe a bounded audio file from the current worktree.",
  "media.video.prepare": "Extract bounded video keyframes and audio into the current worktree for model analysis.",
  "media.image.generate": "Generate an image with the effective Main/Topic Image Model and save it to the worktree.",
  "media.image.edit": "Edit a worktree image with the effective Main/Topic Image Model and save the result.",
  "media.image.models": "List image models discovered from configured image providers.",
  "media.image.current": "Show the effective Image Model for the current worktree/Topic.",
  "github-ci.dispatch": "Dispatch an existing GitHub Actions workflow on an explicit branch/tag/SHA.",
  "github-ci.jobs": "Inspect jobs and steps for a GitHub Actions run before falling back to raw logs.",
  "tailscale.status": "Inspect the bot's current Tailnet connection.",
  "tailscale.devices": "List all Tailnet peers visible to the bot with SSH eligibility diagnostics.",
  "tailscale.ping": "Ping a visible tag:ssh Tailnet peer.",
  "tailscale.ssh-public-key": "Show the bot managed public SSH key for passwordless OpenSSH-over-Tailnet fallback.",
  "ssh.check": "Check Tailscale SSH access to a visible tag:ssh peer.",
  "ssh.debug": "Diagnose Tailscale SSH negotiation and report sanitized compatibility findings.",
  "ssh.exec": "Run a bounded command over Tailscale SSH to a visible tag:ssh peer.",
  "ssh.upload": "Upload a worktree file over Tailscale SSH.",
  "ssh.download": "Download a remote file over Tailscale SSH into the worktree.",
  "telegram.context.current": "Read the latest persisted Telegram message context for the current AI Topic/worktree.",
  "telegram.reply.resolve": "Read the replied Telegram message snapshot for the current AI Topic.",
  "telegram.forward.inspect": "Inspect safe forwarding metadata for the current Telegram message.",
  "telegram.media.fetch": "Fetch media belonging to the current/replied Telegram message into the current worktree.",
  "file.delete": "Delete a file or directory inside the current worktree.",
  "git.reset": "Reset git state in the current worktree.",
  "notify.send": "Send a Telegram notification to the current Topic.",
  "notify.schedule": "Schedule a persisted Telegram notification for the current Topic.",
  "session-extended.create": "Create an OpenCode session without rebinding the current Telegram Topic.",
  "session-extended.delete": "Delete a non-current OpenCode session.",
  "test.test": "Run the project's configured tests or local test runner without downloading tools.",
};

const BOT_READ = new Set([
  "capabilities.list", "projects.list", "worktree.context", "models.providers", "models.list", "models.search", "models.selection", "models.current",
  "agents.list", "agents.current", "variants.list", "variants.current", "skills.list", "commands.list", "mcp.list",
  "extensions.list", "extensions.info", "credentials.status", "generated-actions.list",
  "session.current", "session.messages", "session.latest-assistant", "session.diff", "session.todo", "session.children", "run.status", "tasks.list", "tasks.get", "tasks.parse", "settings.get",
  "memory.list", "memory.search", "providers.list", "providers.get", "providers.free-policy.get", "providers.stt-status",
  "integrations.github.list", "integrations.github.active", "version.info",
]);
const BOT_MUTATING = new Set([
  "models.refresh", "models.select", "agents.select", "variants.select", "skills.create", "skills.update",
  "skills.add", "mcp.add", "mcp.debug", "mcp.enable", "mcp.rename", "integrations.add",
  "extensions.ensure", "credentials.request", "generated-actions.register", "generated-actions.toggle", "providers.ensure", "providers.free-policy.set",
  "tasks.create", "settings.set", "memory.add", "memory.remove", "integrations.github.select",
]);
const BOT_DESTRUCTIVE = new Set(["skills.delete", "mcp.delete", "extensions.remove", "tasks.delete", "memory.clear", "integrations.github.remove"]);

function customRisk(tool: string, action: string): AgentActionRisk {
  if (tool === "bot") {
    if (BOT_DESTRUCTIVE.has(action)) return "destructive";
    if (BOT_MUTATING.has(action)) return "mutating";
    if (BOT_READ.has(action)) return "read";
  }
  if (tool === "file") {
    if (action === "delete") return "destructive";
    if (["write", "copy", "move"].includes(action)) return "write";
    return "read";
  }
  if (tool === "git") {
    if (action === "reset") return "destructive";
    if (["push", "pull", "fetch"].includes(action)) return "external";
    if (["commit", "branch", "checkout", "stash", "merge", "rebase"].includes(action)) return "mutating";
    return "read";
  }
  if (tool === "monitoring" || tool === "security") return "read";
  if (tool === "notify") {
    if (action === "list") return "read";
    if (action === "cancel") return "mutating";
    return "external";
  }
  if (tool === "session-extended") {
    if (action === "delete") return "destructive";
    if (action === "create") return "mutating";
    if (["export", "archive"].includes(action)) return "write";
    return "read";
  }
  if (tool === "test") return ["build", "lint-fix"].includes(action) ? "write" : "read";
  if (tool === "media") return ["stt.status", "image.providers", "image.models", "image.current"].includes(action) ? "read" : "external";
  if (tool === "telegram") return action === "media.fetch" ? "write" : "read";
  if (tool === "browser") {
    if (["click", "fill", "type", "press", "hover", "check", "uncheck", "select", "tab-new", "tab-select", "tab-close", "close"].includes(action)) return "mutating";
    return action === "pdf" ? "write" : "external";
  }
  if (tool === "session") {
    if (["revert", "abort"].includes(action)) return "destructive";
    if (["fork", "unrevert", "summarize"].includes(action)) return "mutating";
    return "read";
  }
  if (tool === "session-recovery") return action === "abort" ? "destructive" : action === "continue" ? "mutating" : "read";
  if (tool === "storage-health" && action === "cleanup-safe") return "destructive";
  if (tool === "safe-download" || tool === "send-file") return "write";
  if (tool === "github-ci") return ["dispatch", "rerun-failed", "cancel"].includes(action) ? "mutating" : "external";
  if (tool === "network-diagnostics") return "external";
  if (tool === "tailscale") return action === "ping" ? "external" : "read";
  if (tool === "ssh") {
    if (["exec", "upload"].includes(action)) return "mutating";
    if (action === "download") return "write";
    return "read";
  }
  return "read";
}

function coreRisk(tool: CoreToolName): AgentActionRisk {
  if (["write", "edit", "apply_patch"].includes(tool)) return "write";
  if (tool === "bash" || tool === "task") return "mutating";
  if (tool === "webfetch" || tool === "websearch") return "external";
  return "read";
}

function descriptionFor(tool: string, action: string): string {
  return DESCRIPTIONS[`${tool}.${action}`] ?? `${tool} action: ${action}.`;
}

function buildCoreActions(): AgentActionDefinition[] {
  return Object.entries(CORE_TOOL_ACTIONS).flatMap(([toolName, actions]) => {
    const tool = toolName as CoreToolName;
    return actions.map((action) => ({
      id: `${tool}.${action}`, tool, action,
      source: tool === "skill" ? "plugin" as const : "opencode-core" as const,
      category: CORE_CATEGORIES[tool], risk: coreRisk(tool), description: descriptionFor(tool, action),
      invocation: { kind: "native-tool" as const, tool },
    }));
  });
}

function buildCustomActions(): AgentActionDefinition[] {
  return Object.entries(CUSTOM_TOOL_ACTIONS).flatMap(([toolName, actions]) => {
    const tool = toolName as CustomToolName;
    return actions.map((action) => ({
      id: `${tool}.${action}`, tool, action, source: "custom-tool" as const,
      category: CUSTOM_CATEGORIES[tool], risk: customRisk(tool, action), description: descriptionFor(tool, action),
      invocation: { kind: "action-tool" as const, tool, actionArgument: "action", actionValue: action },
    }));
  });
}

export const AGENT_ACTIONS: readonly AgentActionDefinition[] = [...buildCoreActions(), ...buildCustomActions()]
  .sort((left, right) => left.id.localeCompare(right.id));

export function getAgentAction(id: string): AgentActionDefinition | null {
  const normalized = id.trim().toLowerCase();
  return AGENT_ACTIONS.find((item) => item.id.toLowerCase() === normalized) ?? null;
}

function filterActions(actions: readonly AgentActionDefinition[], filters: AgentActionFilters): AgentActionDefinition[] {
  const query = filters.query?.trim().toLowerCase();
  return actions.filter((item) => {
    if (filters.tool && item.tool !== filters.tool) return false;
    if (filters.category && item.category !== filters.category) return false;
    if (filters.source && item.source !== filters.source) return false;
    if (filters.risk && item.risk !== filters.risk) return false;
    return !query || `${item.id} ${item.description} ${item.category}`.toLowerCase().includes(query);
  });
}

export function listAgentActions(filters: AgentActionFilters = {}): AgentActionDefinition[] {
  return filterActions(AGENT_ACTIONS, filters);
}

export async function listResolvedAgentActions(filters: AgentActionFilters = {}): Promise<AgentActionDefinition[]> {
  const generated = (await listGeneratedActions())
    .filter((item) => item.enabled)
    .map((item): AgentActionDefinition => ({
      id: item.id,
      tool: item.tool,
      action: item.action,
      source: "generated-extension",
      category: item.category,
      risk: item.risk,
      description: item.description,
      invocation: item.invocation,
    }));
  return filterActions([...AGENT_ACTIONS, ...generated].sort((a, b) => a.id.localeCompare(b.id)), filters);
}

export async function getResolvedAgentAction(id: string): Promise<AgentActionDefinition | null> {
  const normalized = id.trim().toLowerCase();
  return (await listResolvedAgentActions()).find((item) => item.id.toLowerCase() === normalized) ?? null;
}

function summarize(actions: readonly AgentActionDefinition[]): Record<string, unknown> {
  const bySource: Record<string, number> = {}, byCategory: Record<string, number> = {}, byRisk: Record<string, number> = {};
  for (const item of actions) {
    bySource[item.source] = (bySource[item.source] ?? 0) + 1;
    byCategory[item.category] = (byCategory[item.category] ?? 0) + 1;
    byRisk[item.risk] = (byRisk[item.risk] ?? 0) + 1;
  }
  return { total: actions.length, bySource, byCategory, byRisk };
}

export function summarizeAgentActions(): Record<string, unknown> {
  return summarize(AGENT_ACTIONS);
}

export async function summarizeResolvedAgentActions(): Promise<Record<string, unknown>> {
  return summarize(await listResolvedAgentActions());
}

export function getAgentActionSources(): Record<string, unknown> {
  return {
    static: {
      opencodeCore: "Native OpenCode tools have canonical action IDs but keep their native invocation schemas.",
      customTools: "Repository .opencode/tools entries expose explicit action values and are registered here.",
      plugin: "Installed skills/plugins remain discoverable through OpenCode.",
    },
    dynamic: {
      mcp: "Connected MCP servers inject server-defined tools at runtime; OpenCode exposes them directly rather than hard-coding them here.",
      generatedExtensions: "Approved Extensions may register normalized action aliases. User-disabled generated actions stay disabled across regeneration.",
    },
  };
}