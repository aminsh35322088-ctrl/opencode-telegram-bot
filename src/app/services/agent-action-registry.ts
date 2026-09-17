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
    "projects.list",\n    "worktree.context",
    "models.providers", "models.list", "models.search", "models.selection", "models.current", "models.refresh", "models.select",
    "agents.list", "agents.current", "agents.select",
    "variants.list", "variants.current", "variants.select",
    "skills.list", "skills.create", "skills.update", "skills.delete", "skills.import",
    "commands.list",
    "mcp.list", "mcp.add-local", "mcp.add-remote", "mcp.enable", "mcp.disable",
    "session.current", "session.messages", "session.latest-assistant",
    "run.status",
    "tasks.list", "tasks.get", "tasks.parse", "tasks.create", "tasks.delete",
    "settings.get", "settings.set",
    "memory.list", "memory.search", "memory.add", "memory.remove", "memory.clear",
    "providers.list", "providers.get", "providers.stt-status",
    "integrations.github.list", "integrations.github.active", "integrations.github.select", "integrations.github.remove",
    "integrations.railway.list", "integrations.railway.active", "integrations.railway.select", "integrations.railway.remove",
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
  media: ["stt.status", "stt.transcribe", "image.providers", "image.profile", "image.generate", "image.edit"],
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
  media: "media",
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
  "lsp.query": "Use language-server code intelligence.",
  "todowrite.update": "Create or update the agent task list.",
  "task.delegate": "Delegate work to an OpenCode subagent.",
  "question.ask": "Ask the user a structured interactive question.",
  "skill.load": "Load an installed OpenCode skill.",

  "bot.capabilities.list": "List bot control-plane actions available to the model.",
  "bot.projects.list": "List OpenCode projects visible to the bot.",
  "bot.worktree.context": "Inspect the active git worktree and linked worktrees.",
  "bot.models.providers": "List coding-model providers.",
  "bot.models.list": "List models for one provider.",
  "bot.models.search": "Search the live model catalog.",
  "bot.models.selection": "Read favorite and recent model selections.",
  "bot.models.current": "Read the currently selected model.",
  "bot.models.refresh": "Refresh the live model catalog.",
  "bot.models.select": "Select a verified model and optional variant.",
  "bot.agents.list": "List available primary OpenCode agents.",
  "bot.agents.current": "Read the selected agent.",
  "bot.agents.select": "Select an available OpenCode agent.",
  "bot.variants.list": "List variants exposed by a model.",
  "bot.variants.current": "Read the current model variant.",
  "bot.variants.select": "Select a validated variant for the current model.",
  "bot.skills.list": "List installed OpenCode skills.",
  "bot.skills.create": "Create a managed global skill.",
  "bot.skills.update": "Update a managed global skill.",
  "bot.skills.delete": "Delete a managed global skill.",
  "bot.skills.import": "Import a skill from an approved GitHub source without exposing credentials.",
  "bot.commands.list": "List OpenCode custom commands for the current worktree.",
  "bot.mcp.list": "List configured MCP servers and states.",
  "bot.mcp.add-local": "Add a local MCP server definition.",
  "bot.mcp.add-remote": "Add a remote MCP server definition.",
  "bot.mcp.enable": "Connect a configured MCP server.",
  "bot.mcp.disable": "Disconnect a configured MCP server.",
  "bot.session.current": "Read the effective current OpenCode session.",
  "bot.session.messages": "List user messages from the effective current session.",
  "bot.session.latest-assistant": "Read the latest assistant response from the current session.",
  "bot.run.status": "Read the reconciled foreground run/busy state.",
  "bot.tasks.list": "List scheduled tasks.",
  "bot.tasks.get": "Read one scheduled task.",
  "bot.tasks.parse": "Parse and validate a natural-language schedule.",
  "bot.tasks.create": "Create and register a scheduled task using the current worktree, model, and agent.",
  "bot.tasks.delete": "Delete a scheduled task and cancel its runtime timer.",
  "bot.settings.get": "Read safe model-facing bot settings.",
  "bot.settings.set": "Update a constrained safe bot setting.",
  "bot.memory.list": "List persistent bot memories.",
  "bot.memory.search": "Search persistent memories.",
  "bot.memory.add": "Add a persistent memory.",
  "bot.memory.remove": "Remove one persistent memory.",
  "bot.memory.clear": "Delete all persistent memories.",
  "bot.providers.list": "List custom AI-provider metadata without credentials.",
  "bot.providers.get": "Read public metadata for one provider.",
  "bot.providers.stt-status": "Check speech-to-text configuration without exposing its key.",
  "bot.integrations.github.list": "List stored GitHub account metadata without tokens.",
  "bot.integrations.github.active": "Read the active GitHub account metadata.",
  "bot.integrations.github.select": "Switch the active stored GitHub account.",
  "bot.integrations.github.remove": "Remove a stored GitHub account without revealing its token.",
  "bot.integrations.railway.list": "List stored Railway account metadata without tokens.",
  "bot.integrations.railway.active": "Read the active Railway account metadata.",
  "bot.integrations.railway.select": "Switch the active stored Railway account.",
  "bot.integrations.railway.remove": "Remove a stored Railway account without revealing its token.",
  "bot.version.info": "Inspect bot, OpenCode, runtime, and integrated-tool versions.",

  "media.stt.status": "Check whether transcription is configured.",
  "media.stt.transcribe": "Transcribe a bounded audio file from the current worktree.",
  "media.image.providers": "List configured image providers without credentials.",
  "media.image.profile": "Inspect the resolved default Image Chat profile.",
  "media.image.generate": "Generate an image with the configured Image Chat engine and save it to the worktree.",
  "media.image.edit": "Edit a worktree image with the configured Image Chat engine and save the result.",

  "database-query.query": "Run a read-only SQLite query.",
  "image-inspect.inspect": "Inspect image file metadata.",
  "logs-observability.search": "Search bounded runtime/application logs.",
  "safe-download.download": "Download a bounded HTTP(S) resource into the current worktree.",
  "send-file.send": "Deliver a generated artifact through Telegram.",
  "storage-health.inspect": "Inspect persistent volume health.",
  "storage-health.cleanup-safe": "Remove approved disposable caches.",
  "session-recovery.inspect": "Inspect an OpenCode session.",
  "session-recovery.abort": "Abort a non-idle OpenCode session.",
  "session-recovery.continue": "Continue a recoverable OpenCode session.",
  "railway.deploy": "Deploy the current local worktree to Railway.",
  "railway.deploy-latest": "Trigger a Railway deployment from the latest connected-repository commit.",
  "rustdesk.devices.list": "List authorized RustDesk devices and capabilities.",
  "rustdesk.terminal.exec": "Execute a command in an authorized remote terminal.",
  "rustdesk.screen.capture": "Capture the screen of an authorized remote device.",
  "rustdesk.system.restart": "Restart an authorized remote device.",
};

const BOT_READ_ACTIONS = new Set([
  "capabilities.list", "projects.list", "worktree.context",
  "models.providers", "models.list", "models.search", "models.selection", "models.current",
  "agents.list", "agents.current", "variants.list", "variants.current", "skills.list", "commands.list", "mcp.list",
  "session.current", "session.messages", "session.latest-assistant", "run.status",
  "tasks.list", "tasks.get", "tasks.parse", "settings.get",
  "memory.list", "memory.search", "providers.list", "providers.get", "providers.stt-status",
  "integrations.github.list", "integrations.github.active", "integrations.railway.list", "integrations.railway.active",
  "version.info",
]);
const BOT_DESTRUCTIVE_ACTIONS = new Set([
  "skills.delete", "tasks.delete", "memory.clear", "integrations.github.remove", "integrations.railway.remove",
]);
const BOT_MUTATING_ACTIONS = new Set([
  "models.refresh", "models.select", "agents.select", "variants.select",
  "skills.create", "skills.update", "skills.import",
  "mcp.add-local", "mcp.add-remote", "mcp.enable", "mcp.disable",
  "tasks.create", "settings.set", "memory.add", "memory.remove",
  "integrations.github.select", "integrations.railway.select",
]);

function customRisk(tool: string, action: string): AgentActionRisk {
  if (tool === "bot") {
    if (BOT_DESTRUCTIVE_ACTIONS.has(action)) return "destructive";
    if (BOT_MUTATING_ACTIONS.has(action)) return "mutating";
    if (BOT_READ_ACTIONS.has(action)) return "read";
  }
  if (tool === "media") {
    if (action === "stt.status" || action === "image.providers" || action === "image.profile") return "read";
    return "external";
  }
  if (tool === "rustdesk") {
    if (action === "system.restart") return "destructive";
    if (/^(device\.(connect|disconnect)|terminal\.(exec|open|write|close)|mouse\.|keyboard\.|touch\.|clipboard\.write|files\.upload)/.test(action)) return "mutating";
    return "read";
  }
  if (tool === "browser") {
    if (["click", "fill", "type", "press", "hover", "check", "uncheck", "select", "tab-new", "tab-select", "tab-close", "close"].includes(action)) return "mutating";
    return action === "pdf" ? "write" : "external";
  }
  if (tool === "railway" && ["deploy", "deploy-latest"].includes(action)) return "mutating";
  if (tool === "session-recovery") {
    if (action === "abort") return "destructive";
    if (action === "continue") return "mutating";
    return "read";
  }
  if (tool === "storage-health" && action === "cleanup-safe") return "destructive";
  if (tool === "safe-download" || tool === "send-file") return "write";
  if (tool === "network-diagnostics" || tool === "github-ci") return "external";
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
      opencodeCore: "Native OpenCode tools are represented by canonical action IDs and invoked with native schemas.",
      customTools: "Repository .opencode/tools entries expose explicit action values and are registered here.",
      plugin: "Installed plugin/skill capabilities remain discoverable through OpenCode.",
    },
    dynamic: {
      mcp: "Connected MCP servers inject server-defined tools at runtime. They are exposed by OpenCode directly and intentionally are not hard-coded in the static registry.",
    },
  };
}
