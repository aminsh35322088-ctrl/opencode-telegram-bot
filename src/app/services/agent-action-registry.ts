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
  bash: ["exec"],
  read: ["read"],
  write: ["write"],
  edit: ["edit"],
  apply_patch: ["apply"],
  grep: ["search"],
  glob: ["search"],
  webfetch: ["fetch"],
  websearch: ["search"],
  lsp: ["query"],
  todowrite: ["update"],
  task: ["delegate"],
  question: ["ask"],
  skill: ["load"],
} as const;

export const CUSTOM_TOOL_ACTIONS = {
  actions: ["list", "describe", "resolve", "sources", "summary"],
  bot: [
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
  ],
  browser: [
    "open", "goto", "back", "forward", "reload", "snapshot", "screenshot",
    "click", "fill", "type", "press", "hover", "check", "uncheck", "select",
    "close", "tab-list", "tab-new", "tab-select", "tab-close", "requests", "console", "pdf",
  ],
  "database-query": ["query"],
  "full-diagnostics": ["quick", "full"],
  "github-ci": ["status", "watch", "logs", "verify"],
  "image-inspect": ["inspect"],
  "logs-observability": ["search"],
  "network-diagnostics": ["dns", "http", "tcp"],
  railway: ["whoami", "status", "logs", "variables", "deploy", "deploy-latest"],
  rustdesk: [
    "bridge.health", "devices.list", "device.info", "device.connect", "device.disconnect",
    "terminal.exec", "terminal.open", "terminal.write", "terminal.read", "terminal.close",
    "screen.capture", "mouse.move", "mouse.click", "mouse.doubleClick", "mouse.drag", "mouse.scroll",
    "keyboard.type", "keyboard.press", "touch.tap", "touch.longPress", "touch.swipe",
    "clipboard.read", "clipboard.write", "files.list", "files.read", "files.upload", "files.download",
    "system.info", "system.restart",
  ],
  "safe-download": ["download"],
  "send-file": ["send"],
  "session-recovery": ["inspect", "abort", "continue"],
  "storage-health": ["inspect", "cleanup-safe"],
  "system-diagnostics": ["summary", "processes", "disk"],
} as const;

type CustomToolName = keyof typeof CUSTOM_TOOL_ACTIONS;

const TOOL_CATEGORIES: Record<CustomToolName, string> = {
  actions: "discovery",
  bot: "bot-control",
  browser: "browser",
  "database-query": "database",
  "full-diagnostics": "diagnostics",
  "github-ci": "ci",
  "image-inspect": "media",
  "logs-observability": "observability",
  "network-diagnostics": "network",
  railway: "deployment",
  rustdesk: "remote-control",
  "safe-download": "transfer",
  "send-file": "transfer",
  "session-recovery": "session",
  "storage-health": "storage",
  "system-diagnostics": "diagnostics",
};

const CORE_CATEGORIES: Record<keyof typeof CORE_TOOL_ACTIONS, string> = {
  bash: "shell",
  read: "filesystem",
  write: "filesystem",
  edit: "filesystem",
  apply_patch: "filesystem",
  grep: "filesystem",
  glob: "filesystem",
  webfetch: "web",
  websearch: "web",
  lsp: "code-intelligence",
  todowrite: "agent-workflow",
  task: "agent-workflow",
  question: "agent-workflow",
  skill: "agent-workflow",
};

const ACTION_DESCRIPTIONS: Record<string, string> = {
  "bash.exec": "Execute a shell command using OpenCode's native bash tool.",
  "read.read": "Read file content using OpenCode's native read tool.",
  "write.write": "Create or replace file content using OpenCode's native write tool.",
  "edit.edit": "Apply a targeted text edit using OpenCode's native edit tool.",
  "apply_patch.apply": "Apply a structured patch to one or more files.",
  "grep.search": "Search file contents with OpenCode's native grep tool.",
  "glob.search": "Discover files by path pattern with OpenCode's native glob tool.",
  "webfetch.fetch": "Fetch and inspect a web resource.",
  "websearch.search": "Search the public web when the configured OpenCode provider supports it.",
  "lsp.query": "Use language-server code intelligence such as definitions, references, symbols, and hover.",
  "todowrite.update": "Create or update the agent's structured task list.",
  "task.delegate": "Delegate work to an OpenCode subagent.",
  "question.ask": "Ask the user a structured interactive question.",
  "skill.load": "Load an installed OpenCode skill and follow its workflow.",
  "bot.capabilities.list": "List the bot control-plane actions exposed to the coding agent.",
  "bot.projects.list": "List OpenCode projects visible to the bot.",
  "bot.worktree.context": "Inspect the active git worktree and linked worktrees.",
  "bot.models.providers": "List coding-model providers visible through the bot catalog.",
  "bot.models.list": "List coding models for one provider.",
  "bot.models.search": "Search the bot model catalog.",
  "bot.models.refresh": "Refresh the bot model catalog from configured providers.",
  "bot.agents.list": "List available primary OpenCode agents for the current worktree.",
  "bot.variants.list": "List variants exposed by a provider/model pair.",
  "bot.skills.list": "List installed OpenCode skills.",
  "bot.skills.create": "Create a managed global OpenCode skill.",
  "bot.skills.update": "Update a managed global OpenCode skill.",
  "bot.skills.delete": "Delete a managed global OpenCode skill.",
  "bot.commands.list": "List OpenCode custom commands for the current worktree.",
  "bot.mcp.list": "List configured MCP servers and connection states.",
  "bot.mcp.add-local": "Add a local MCP server definition.",
  "bot.mcp.add-remote": "Add a remote MCP server definition.",
  "bot.mcp.enable": "Connect an existing MCP server.",
  "bot.mcp.disable": "Disconnect an MCP server.",
  "bot.memory.list": "List persistent bot memories.",
  "bot.memory.search": "Search persistent bot memories relevant to a query.",
  "bot.memory.add": "Add a persistent user or project memory.",
  "bot.memory.remove": "Remove one persistent memory by ID.",
  "bot.memory.clear": "Delete all persistent memories.",
  "bot.providers.list": "List configured custom AI providers without credentials.",
  "bot.providers.get": "Read public metadata for one configured custom provider.",
  "bot.providers.stt-status": "Check whether Groq speech-to-text is configured without exposing its key.",
  "bot.version.info": "Inspect bot, OpenCode, runtime, and integrated-tool versions.",
  "database-query.query": "Run a read-only SQLite SELECT/PRAGMA/WITH/EXPLAIN query.",
  "image-inspect.inspect": "Inspect image format, dimensions, colorspace, depth, and metadata.",
  "logs-observability.search": "Search bounded recent application/runtime logs.",
  "safe-download.download": "Download a bounded HTTP(S) resource into the current worktree.",
  "send-file.send": "Deliver a generated file or artifact to the user through Telegram.",
  "storage-health.inspect": "Inspect persistent /data volume health and disposable cache usage.",
  "storage-health.cleanup-safe": "Remove only approved disposable caches from persistent storage.",
  "session-recovery.inspect": "Inspect the state of an OpenCode session.",
  "session-recovery.abort": "Abort a non-idle OpenCode session while preserving its history.",
  "session-recovery.continue": "Recover and continue an OpenCode session with a fresh prompt.",
  "railway.deploy": "Deploy the current local worktree to Railway through the Railway CLI.",
  "railway.deploy-latest": "Trigger a Railway deployment from the latest commit of the connected repository.",
  "rustdesk.devices.list": "List authorized RustDesk devices with OS and capability metadata.",
  "rustdesk.terminal.exec": "Execute a command in an authorized remote device terminal.",
  "rustdesk.screen.capture": "Capture the current screen of an authorized remote device.",
  "rustdesk.system.restart": "Restart an authorized remote device when that capability is permitted.",
};

const READ_ACTION_PATTERNS = [
  /^(list|describe|resolve|sources|summary|status|inspect|snapshot|screenshot|requests|console|whoami|logs|variables|verify|watch|dns|http|tcp|quick|full|search)$/,
  /^(bridge\.health|devices\.list|device\.info|terminal\.read|screen\.capture|clipboard\.read|files\.list|files\.read|system\.info)$/,
  /^(capabilities\.list|projects\.list|worktree\.context|models\.(providers|list|search)|agents\.list|variants\.list|skills\.list|commands\.list|mcp\.list|memory\.(list|search)|providers\.(list|get|stt-status)|version\.info)$/,
];
const DESTRUCTIVE_ACTION_PATTERNS = [/restart$/, /^cleanup-safe$/, /^abort$/, /^skills\.delete$/, /^memory\.clear$/];
const WRITE_ACTION_PATTERNS = [/^pdf$/, /^download$/, /^send$/, /^files\.download$/];

function customRisk(tool: string, action: string): AgentActionRisk {
  if (DESTRUCTIVE_ACTION_PATTERNS.some((pattern) => pattern.test(action))) return "destructive";
  if (tool === "bot" && ["skills.create", "skills.update", "mcp.add-local", "mcp.add-remote", "mcp.enable", "mcp.disable", "memory.add", "memory.remove", "models.refresh"].includes(action)) return "mutating";
  if (tool === "browser" && ["click", "fill", "type", "press", "hover", "check", "uncheck", "select", "tab-new", "tab-select", "tab-close", "close"].includes(action)) return "mutating";
  if (tool === "railway" && ["deploy", "deploy-latest"].includes(action)) return "mutating";
  if (tool === "rustdesk" && /^(device\.(connect|disconnect)|terminal\.(exec|open|write|close)|mouse\.|keyboard\.|touch\.|clipboard\.write|files\.upload)/.test(action)) return "mutating";
  if (tool === "session-recovery" && action === "continue") return "mutating";
  if (WRITE_ACTION_PATTERNS.some((pattern) => pattern.test(action))) return "write";
  if (READ_ACTION_PATTERNS.some((pattern) => pattern.test(action))) return "read";
  if (tool === "browser" || tool === "network-diagnostics" || tool === "github-ci") return "external";
  return "read";
}

function coreRisk(tool: keyof typeof CORE_TOOL_ACTIONS): AgentActionRisk {
  if (["write", "edit", "apply_patch"].includes(tool)) return "write";
  if (tool === "bash" || tool === "task") return "mutating";
  if (tool === "webfetch" || tool === "websearch") return "external";
  return "read";
}

function descriptionFor(tool: string, action: string): string {
  return ACTION_DESCRIPTIONS[`${tool}.${action}`] ?? `${tool} action: ${action}.`;
}

function buildCoreActions(): AgentActionDefinition[] {
  return Object.entries(CORE_TOOL_ACTIONS).flatMap(([toolName, actions]) => {
    const tool = toolName as keyof typeof CORE_TOOL_ACTIONS;
    return actions.map((action) => ({
      id: `${tool}.${action}`,
      tool,
      action,
      source: tool === "skill" ? "plugin" as const : "opencode-core" as const,
      category: CORE_CATEGORIES[tool],
      risk: coreRisk(tool),
      description: descriptionFor(tool, action),
      invocation: { kind: "native-tool" as const, tool },
    }));
  });
}

function buildCustomActions(): AgentActionDefinition[] {
  return Object.entries(CUSTOM_TOOL_ACTIONS).flatMap(([toolName, actions]) => {
    const tool = toolName as CustomToolName;
    return actions.map((action) => ({
      id: `${tool}.${action}`,
      tool,
      action,
      source: "custom-tool" as const,
      category: TOOL_CATEGORIES[tool],
      risk: customRisk(tool, action),
      description: descriptionFor(tool, action),
      invocation: {
        kind: "action-tool" as const,
        tool,
        actionArgument: "action",
        actionValue: action,
      },
    }));
  });
}

export const AGENT_ACTIONS: readonly AgentActionDefinition[] = [
  ...buildCoreActions(),
  ...buildCustomActions(),
].sort((left, right) => left.id.localeCompare(right.id));

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
    if (query && !`${item.id} ${item.description} ${item.category}`.toLowerCase().includes(query)) return false;
    return true;
  });
}

export function summarizeAgentActions(): Record<string, unknown> {
  const bySource: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const byRisk: Record<string, number> = {};
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
      opencodeCore: "Native OpenCode tools are represented by canonical action IDs but are invoked with their native schemas.",
      customTools: "Repository .opencode/tools entries use an explicit action argument and are included in this registry.",
      botControl: "The bot custom tool exposes model-safe bot control-plane actions without returning provider credentials.",
      plugin: "The skill action is supplied by the configured OpenCode/Superpowers workflow.",
    },
    dynamic: {
      mcp: "Connected MCP servers can inject additional model tools at runtime. Their names and schemas are server-defined, so they cannot be safely hard-coded; OpenCode exposes them directly when connected.",
    },
  };
}
