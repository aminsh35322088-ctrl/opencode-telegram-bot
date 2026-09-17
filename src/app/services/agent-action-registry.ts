export const AGENT_ACTION_SOURCES = ["opencode-core", "custom-tool", "plugin", "dynamic-mcp"] as const;
export type AgentActionSource = (typeof AGENT_ACTION_SOURCES)[number];

export const AGENT_ACTION_RISKS = ["read", "write", "external", "mutating", "destructive"] as const;
export type AgentActionRisk = (typeof AGENT_ACTION_RISKS)[number];

export interface AgentActionInvocation {
  kind: "native-tool" | "action-tool";
  tool: string;
  actionArgument?: string;
  actionValue?: string;
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
    "skills.list", "skills.create", "skills.update", "skills.delete", "skills.import", "commands.list",
    "mcp.list", "mcp.add-local", "mcp.add-remote", "mcp.enable", "mcp.disable",
    "session.current", "session.messages", "session.latest-assistant", "run.status",
    "tasks.list", "tasks.get", "tasks.parse", "tasks.create", "tasks.delete",
    "settings.get", "settings.set",
    "memory.list", "memory.search", "memory.add", "memory.remove", "memory.clear",
    "providers.list", "providers.get", "providers.stt-status",
    "integrations.github.list", "integrations.github.active", "integrations.github.select", "integrations.github.remove",
    "integrations.railway.list", "integrations.railway.active", "integrations.railway.select", "integrations.railway.remove",
    "version.info",
  ],
  browser: [
    "open", "goto", "back", "forward", "reload", "snapshot", "screenshot", "click", "fill", "type", "press",
    "hover", "check", "uncheck", "select", "close", "tab-list", "tab-new", "tab-select", "tab-close", "requests", "console", "pdf",
  ],
  "database-query": ["query"],
  "full-diagnostics": ["quick", "full"],
  "github-ci": ["status", "watch", "logs", "verify"],
  "image-inspect": ["inspect"],
  "logs-observability": ["search"],
  media: ["stt.status", "stt.transcribe", "image.providers", "image.profile", "image.generate", "image.edit"],
  "network-diagnostics": ["dns", "http", "tcp"],
  railway: ["whoami", "status", "logs", "variables", "deploy", "deploy-latest"],
  rustdesk: [
    "bridge.health",
    "servers.list", "servers.get", "servers.test",
    "devices.list", "devices.get", "devices.connect",
    "session.connectTemporary", "connection.status", "connection.disconnect",
    "terminal.open", "terminal.write", "terminal.read", "terminal.resize", "terminal.close", "terminal.exec",
    "screen.capture",
    "mouse.move", "mouse.click", "mouse.doubleClick", "mouse.drag", "mouse.scroll",
    "keyboard.type", "keyboard.press",
    "touch.tap", "touch.longPress", "touch.swipe",
    "clipboard.read", "clipboard.write",
    "files.list", "files.read", "files.upload", "files.download",
    "system.info", "system.restart",
  ],
  "safe-download": ["download"],
  "send-file": ["send"],
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
  actions: "discovery", bot: "bot-control", browser: "browser", "database-query": "database",
  "full-diagnostics": "diagnostics", "github-ci": "ci", "image-inspect": "media", "logs-observability": "observability",
  media: "media", "network-diagnostics": "network", railway: "deployment", rustdesk: "remote-control",
  "safe-download": "transfer", "send-file": "transfer", "session-recovery": "session", "storage-health": "storage",
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
  "media.stt.transcribe": "Transcribe a bounded audio file from the current worktree.",
  "media.image.generate": "Generate an image with the configured Image Chat engine and save it to the worktree.",
  "media.image.edit": "Edit a worktree image with the configured Image Chat engine and save the result.",
  "rustdesk.servers.list": "List model-selectable RustDesk public and saved custom server profiles without secrets.",
  "rustdesk.servers.test": "Test reachability/configuration of a RustDesk connection server without authenticating to a target.",
  "rustdesk.devices.list": "List saved permanent RustDesk devices with server, OS, and capability metadata.",
  "rustdesk.devices.connect": "Connect to a saved RustDesk device using its saved server profile and bridge-only credential.",
  "rustdesk.session.connectTemporary": "Create an ephemeral RustDesk connection with explicit peer, server, and authentication mode.",
  "rustdesk.connection.status": "Inspect safe live RustDesk connection, capability, and permission state.",
  "rustdesk.terminal.exec": "Execute a command through an authorized remote RustDesk terminal connection.",
  "rustdesk.screen.capture": "Capture the current screen of an authorized RustDesk connection.",
  "rustdesk.system.restart": "Restart an authorized remote device through RustDesk's normal remote restart path.",
};

const BOT_READ = new Set([
  "capabilities.list", "projects.list", "worktree.context", "models.providers", "models.list", "models.search", "models.selection", "models.current",
  "agents.list", "agents.current", "variants.list", "variants.current", "skills.list", "commands.list", "mcp.list",
  "session.current", "session.messages", "session.latest-assistant", "run.status", "tasks.list", "tasks.get", "tasks.parse", "settings.get",
  "memory.list", "memory.search", "providers.list", "providers.get", "providers.stt-status",
  "integrations.github.list", "integrations.github.active", "integrations.railway.list", "integrations.railway.active", "version.info",
]);
const BOT_MUTATING = new Set([
  "models.refresh", "models.select", "agents.select", "variants.select", "skills.create", "skills.update", "skills.import",
  "mcp.add-local", "mcp.add-remote", "mcp.enable", "mcp.disable", "tasks.create", "settings.set", "memory.add", "memory.remove",
  "integrations.github.select", "integrations.railway.select",
]);
const BOT_DESTRUCTIVE = new Set(["skills.delete", "tasks.delete", "memory.clear", "integrations.github.remove", "integrations.railway.remove"]);

function customRisk(tool: string, action: string): AgentActionRisk {
  if (tool === "bot") {
    if (BOT_DESTRUCTIVE.has(action)) return "destructive";
    if (BOT_MUTATING.has(action)) return "mutating";
    if (BOT_READ.has(action)) return "read";
  }
  if (tool === "media") return ["stt.status", "image.providers", "image.profile"].includes(action) ? "read" : "external";
  if (tool === "rustdesk") {
    if (action === "system.restart") return "destructive";
    if (action === "servers.test") return "external";
    if (action === "files.download") return "write";
    if (
      ["devices.connect", "session.connectTemporary", "connection.disconnect"].includes(action) ||
      /^(terminal\.(exec|open|write|resize|close)|mouse\.|keyboard\.|touch\.|clipboard\.write|files\.upload)/.test(action)
    ) {
      return "mutating";
    }
    return "read";
  }
  if (tool === "browser") {
    if (["click", "fill", "type", "press", "hover", "check", "uncheck", "select", "tab-new", "tab-select", "tab-close", "close"].includes(action)) return "mutating";
    return action === "pdf" ? "write" : "external";
  }
  if (tool === "railway" && ["deploy", "deploy-latest"].includes(action)) return "mutating";
  if (tool === "session-recovery") return action === "abort" ? "destructive" : action === "continue" ? "mutating" : "read";
  if (tool === "storage-health" && action === "cleanup-safe") return "destructive";
  if (tool === "safe-download" || tool === "send-file") return "write";
  if (tool === "network-diagnostics" || tool === "github-ci") return "external";
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

export function listAgentActions(filters: AgentActionFilters = {}): AgentActionDefinition[] {
  const query = filters.query?.trim().toLowerCase();
  return AGENT_ACTIONS.filter((item) => {
    if (filters.tool && item.tool !== filters.tool) return false;
    if (filters.category && item.category !== filters.category) return false;
    if (filters.source && item.source !== filters.source) return false;
    if (filters.risk && item.risk !== filters.risk) return false;
    return !query || `${item.id} ${item.description} ${item.category}`.toLowerCase().includes(query);
  });
}

export function summarizeAgentActions(): Record<string, unknown> {
  const bySource: Record<string, number> = {}, byCategory: Record<string, number> = {}, byRisk: Record<string, number> = {};
  for (const item of AGENT_ACTIONS) {
    bySource[item.source] = (bySource[item.source] ?? 0) + 1;
    byCategory[item.category] = (byCategory[item.category] ?? 0) + 1;
    byRisk[item.risk] = (byRisk[item.risk] ?? 0) + 1;
  }
  return { total: AGENT_ACTIONS.length, bySource, byCategory, byRisk };
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
    },
  };
}
