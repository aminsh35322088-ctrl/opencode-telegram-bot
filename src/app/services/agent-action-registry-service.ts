export type AgentActionSource = "custom" | "opencode" | "runtime" | "dynamic";
export type AgentActionRisk = "read" | "write" | "external" | "mutating" | "destructive";
export type AgentActionApproval = "allow" | "ask";

export interface AgentActionDefinition {
  id: string;
  tool: string;
  action: string;
  category: string;
  description: string;
  source: AgentActionSource;
  risk: AgentActionRisk;
  approval: AgentActionApproval;
  invokeWith: string;
  dynamic?: boolean;
}

export interface AgentActionFilters {
  tool?: string;
  category?: string;
  source?: AgentActionSource;
  risk?: AgentActionRisk;
  query?: string;
  limit?: number;
}

function define(
  tool: string,
  action: string,
  category: string,
  description: string,
  source: AgentActionSource,
  risk: AgentActionRisk,
  approval: AgentActionApproval,
  invokeWith = tool,
  dynamic = false,
): AgentActionDefinition {
  return {
    id: `${tool}.${action}`,
    tool,
    action,
    category,
    description,
    source,
    risk,
    approval,
    invokeWith,
    ...(dynamic ? { dynamic: true } : {}),
  };
}

const browserActions = [
  ["open", "Open a browser session or URL"],
  ["goto", "Navigate the current page to a URL"],
  ["snapshot", "Read the current page accessibility snapshot"],
  ["screenshot", "Capture a page or element screenshot"],
  ["click", "Click an element"],
  ["fill", "Replace an input value"],
  ["type", "Type text into the page"],
  ["press", "Press a keyboard key or shortcut"],
  ["hover", "Hover an element"],
  ["check", "Check a checkbox"],
  ["uncheck", "Uncheck a checkbox"],
  ["select", "Select an option"],
  ["close", "Close the browser session"],
  ["tab-list", "List browser tabs"],
  ["tab-new", "Open a new browser tab"],
  ["tab-select", "Select a browser tab"],
  ["tab-close", "Close a browser tab"],
  ["requests", "Inspect recent network requests"],
  ["console", "Inspect browser console output"],
  ["pdf", "Save the current page as PDF"],
  ["back", "Navigate backward"],
  ["forward", "Navigate forward"],
  ["reload", "Reload the current page"],
] as const;

const rustDeskActions = [
  ["bridge.health", "Check the RustDesk bridge health"],
  ["devices.list", "List enrolled RustDesk devices and capabilities"],
  ["device.info", "Inspect a remote device"],
  ["device.connect", "Connect to a remote device"],
  ["device.disconnect", "Disconnect from a remote device"],
  ["terminal.exec", "Run a command on a remote device"],
  ["terminal.open", "Open a persistent remote terminal"],
  ["terminal.write", "Write input to a remote terminal"],
  ["terminal.read", "Read buffered remote terminal output"],
  ["terminal.close", "Close a remote terminal"],
  ["screen.capture", "Capture the remote screen"],
  ["mouse.move", "Move the remote mouse pointer"],
  ["mouse.click", "Click the remote mouse"],
  ["mouse.doubleClick", "Double-click the remote mouse"],
  ["mouse.drag", "Drag with the remote mouse"],
  ["mouse.scroll", "Scroll the remote mouse"],
  ["keyboard.type", "Type text on the remote device"],
  ["keyboard.press", "Press remote keyboard keys"],
  ["touch.tap", "Tap a remote touch target"],
  ["touch.longPress", "Long-press a remote touch target"],
  ["touch.swipe", "Swipe on a remote touch device"],
  ["clipboard.read", "Read the remote clipboard"],
  ["clipboard.write", "Write the remote clipboard"],
  ["files.list", "List remote files"],
  ["files.read", "Read a remote file"],
  ["files.upload", "Upload a file to a remote device"],
  ["files.download", "Download a file from a remote device"],
  ["system.info", "Inspect remote system information"],
  ["system.restart", "Restart the remote device"],
] as const;

const customActions: AgentActionDefinition[] = [
  define("actions", "list", "discovery", "List normalized actions available to the model", "custom", "read", "allow"),
  define("actions", "describe", "discovery", "Describe one normalized action", "custom", "read", "allow"),
  define("actions", "capabilities", "discovery", "Summarize action sources and capability groups", "custom", "read", "allow"),
  ...browserActions.map(([action, description]) =>
    define("browser", action, "browser", description, "custom", action === "snapshot" || action === "requests" || action === "console" || action === "tab-list" ? "read" : "external", "ask"),
  ),
  define("database-query", "query", "database", "Run a read-only SQLite query", "custom", "read", "ask"),
  define("full-diagnostics", "quick", "diagnostics", "Run bounded core runtime diagnostics", "custom", "read", "allow"),
  define("full-diagnostics", "full", "diagnostics", "Run extended runtime/project diagnostics", "custom", "read", "allow"),
  define("github-ci", "status", "ci", "Inspect the latest GitHub Actions CI run", "custom", "read", "allow"),
  define("github-ci", "watch", "ci", "Wait briefly for a GitHub Actions run", "custom", "read", "allow"),
  define("github-ci", "logs", "ci", "Fetch GitHub Actions failure logs", "custom", "read", "allow"),
  define("github-ci", "verify", "ci", "Wait for CI and return failure logs when needed", "custom", "read", "allow"),
  define("image-inspect", "inspect", "media", "Inspect image format, dimensions and metadata", "custom", "read", "allow"),
  define("logs-observability", "search", "observability", "Search bounded runtime/application logs", "custom", "read", "allow"),
  define("network-diagnostics", "dns", "network", "Resolve a DNS target from the runtime", "custom", "external", "allow"),
  define("network-diagnostics", "http", "network", "Check HTTP(S) connectivity", "custom", "external", "allow"),
  define("network-diagnostics", "tcp", "network", "Check TCP connectivity", "custom", "external", "allow"),
  define("railway", "whoami", "railway", "Verify Railway authentication", "custom", "external", "allow"),
  define("railway", "status", "railway", "Inspect Railway project/service status", "custom", "external", "allow"),
  define("railway", "logs", "railway", "Read bounded Railway deployment logs", "custom", "external", "allow"),
  define("railway", "variables", "railway", "List Railway variable names", "custom", "external", "allow"),
  define("railway", "deploy", "railway", "Trigger a local-upload Railway deployment", "custom", "mutating", "ask"),
  define("railway", "deploy-latest", "railway", "Deploy the latest connected GitHub revision", "custom", "mutating", "ask"),
  ...rustDeskActions.map(([action, description]) => {
    const read = action === "bridge.health" || action === "devices.list" || action === "device.info" || action === "terminal.read" || action === "screen.capture" || action === "clipboard.read" || action === "files.list" || action === "files.read" || action === "system.info";
    const destructive = action === "system.restart";
    return define("rustdesk", action, "remote-control", description, "custom", destructive ? "destructive" : read ? "read" : "mutating", read ? "allow" : "ask");
  }),
  define("safe-download", "download", "files", "Download a bounded HTTP(S) file into the worktree", "custom", "external", "allow"),
  define("send-file", "send", "telegram", "Send a generated file/artifact to the user", "custom", "external", "allow"),
  define("session-recovery", "inspect", "session", "Inspect a potentially stalled OpenCode session", "custom", "read", "allow"),
  define("session-recovery", "abort", "session", "Abort a non-idle OpenCode session", "custom", "mutating", "ask"),
  define("session-recovery", "continue", "session", "Continue a preserved OpenCode session with a new prompt", "custom", "mutating", "ask"),
  define("storage-health", "inspect", "storage", "Inspect persistent storage usage", "custom", "read", "allow"),
  define("storage-health", "cleanup-safe", "storage", "Remove only disposable package/tool caches", "custom", "mutating", "ask"),
  define("system-diagnostics", "summary", "diagnostics", "Inspect runtime CPU, memory, uptime and filesystem summary", "custom", "read", "allow"),
  define("system-diagnostics", "processes", "diagnostics", "Inspect running processes", "custom", "read", "allow"),
  define("system-diagnostics", "disk", "diagnostics", "Inspect filesystem capacity", "custom", "read", "allow"),
];

const builtInActions: AgentActionDefinition[] = [
  define("bash", "exec", "shell", "Run an allowed shell command", "opencode", "mutating", "ask", "bash"),
  define("read", "file", "filesystem", "Read a file from the workspace", "opencode", "read", "allow", "read"),
  define("write", "file", "filesystem", "Create or replace a workspace file", "opencode", "write", "ask", "write"),
  define("edit", "file", "filesystem", "Apply a focused edit to a workspace file", "opencode", "write", "ask", "edit"),
  define("apply_patch", "apply", "filesystem", "Apply a source patch", "opencode", "write", "ask", "apply_patch"),
  define("grep", "search", "search", "Search file contents", "opencode", "read", "allow", "grep"),
  define("glob", "search", "search", "Find workspace paths by pattern", "opencode", "read", "allow", "glob"),
  define("webfetch", "fetch", "web", "Fetch a web resource", "opencode", "external", "allow", "webfetch"),
  define("websearch", "search", "web", "Search the public web", "opencode", "external", "allow", "websearch"),
  define("lsp", "query", "code-intelligence", "Use language-server code intelligence", "opencode", "read", "allow", "lsp"),
  define("todowrite", "update", "planning", "Update the agent task/todo list", "opencode", "write", "allow", "todowrite"),
  define("task", "run", "agents", "Run a delegated subagent task", "opencode", "mutating", "allow", "task"),
  define("question", "ask", "interaction", "Ask the user a structured question", "opencode", "external", "allow", "question"),
  define("skill", "run", "skills", "Load and follow an installed OpenCode skill", "opencode", "read", "allow", "skill"),
];

const runtimeActions: AgentActionDefinition[] = [
  define("runtime", "git", "developer-tools", "Run Git operations through bash", "runtime", "mutating", "ask", "bash"),
  define("runtime", "git-lfs", "developer-tools", "Run Git LFS operations through bash", "runtime", "mutating", "ask", "bash"),
  define("runtime", "github-cli", "developer-tools", "Use gh for repositories, issues, PRs, Actions and releases", "runtime", "external", "ask", "bash"),
  define("runtime", "zip", "archives", "Create ZIP archives", "runtime", "write", "allow", "bash"),
  define("runtime", "unzip", "archives", "Extract ZIP archives", "runtime", "write", "allow", "bash"),
  define("runtime", "jq", "developer-tools", "Process JSON with jq", "runtime", "read", "allow", "bash"),
  define("runtime", "ripgrep", "search", "Search source quickly with rg", "runtime", "read", "allow", "bash"),
  define("runtime", "fd", "search", "Find files quickly with fd/fdfind", "runtime", "read", "allow", "bash"),
  define("runtime", "tree", "filesystem", "Inspect directory trees", "runtime", "read", "allow", "bash"),
  define("runtime", "file", "filesystem", "Detect file types", "runtime", "read", "allow", "bash"),
  define("runtime", "rsync", "filesystem", "Synchronize files", "runtime", "write", "ask", "bash"),
  define("runtime", "curl", "network", "Make HTTP requests with curl", "runtime", "external", "allow", "bash"),
  define("runtime", "wget", "network", "Download HTTP resources with wget", "runtime", "external", "allow", "bash"),
  define("runtime", "ssh", "network", "Use OpenSSH client for authorized remote systems", "runtime", "external", "ask", "bash"),
  define("runtime", "ps", "system", "Inspect processes with procps", "runtime", "read", "allow", "bash"),
  define("runtime", "railway-cli", "railway", "Use Railway CLI directly when the structured tool is insufficient", "runtime", "external", "ask", "bash"),
  define("runtime", "playwright-cli", "browser", "Use Playwright CLI directly", "runtime", "external", "ask", "bash"),
  define("runtime", "pnpm", "developer-tools", "Use pnpm commands allowed by runtime policy", "runtime", "mutating", "ask", "bash"),
  define("runtime", "tsx", "developer-tools", "Execute TypeScript utilities with tsx", "runtime", "mutating", "ask", "bash"),
  define("runtime", "typescript", "developer-tools", "Run the TypeScript compiler", "runtime", "read", "allow", "bash"),
  define("runtime", "eslint", "developer-tools", "Run ESLint", "runtime", "read", "allow", "bash"),
  define("runtime", "vitest", "developer-tools", "Run Vitest when permitted by runtime policy", "runtime", "read", "allow", "bash"),
  define("runtime", "python", "developer-tools", "Run Python utilities", "runtime", "mutating", "ask", "bash"),
  define("runtime", "pytest", "developer-tools", "Run pytest when permitted by runtime policy", "runtime", "read", "allow", "bash"),
  define("runtime", "sqlite", "database", "Use sqlite3 CLI", "runtime", "mutating", "ask", "bash"),
  define("runtime", "ffmpeg", "media", "Inspect or transform media with FFmpeg", "runtime", "write", "ask", "bash"),
  define("runtime", "imagemagick", "media", "Inspect or transform images with ImageMagick", "runtime", "write", "ask", "bash"),
];

const dynamicActions: AgentActionDefinition[] = [
  define("mcp", "dynamic-tools", "integrations", "Tools exposed by connected MCP servers are injected dynamically by OpenCode", "dynamic", "external", "ask", "mcp", true),
  define("skills", "dynamic-catalog", "skills", "Installed/imported skills are discovered dynamically by OpenCode", "dynamic", "read", "allow", "skill", true),
];

export const AGENT_ACTIONS: readonly AgentActionDefinition[] = Object.freeze([
  ...customActions,
  ...builtInActions,
  ...runtimeActions,
  ...dynamicActions,
]);

const byId = new Map(AGENT_ACTIONS.map((item) => [item.id, item]));
if (byId.size !== AGENT_ACTIONS.length) {
  throw new Error("Duplicate agent action id in registry");
}

function normalize(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed || undefined;
}

export function listAgentActions(filters: AgentActionFilters = {}): AgentActionDefinition[] {
  const tool = normalize(filters.tool);
  const category = normalize(filters.category);
  const query = normalize(filters.query);
  const limit = Number.isFinite(filters.limit)
    ? Math.max(1, Math.min(Math.trunc(filters.limit ?? 200), 500))
    : 200;

  return AGENT_ACTIONS.filter((item) => {
    if (tool && item.tool.toLowerCase() !== tool) return false;
    if (category && item.category.toLowerCase() !== category) return false;
    if (filters.source && item.source !== filters.source) return false;
    if (filters.risk && item.risk !== filters.risk) return false;
    if (query) {
      const haystack = `${item.id} ${item.category} ${item.description} ${item.invokeWith}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  }).slice(0, limit);
}

export function getAgentAction(id: string): AgentActionDefinition | null {
  return byId.get(id.trim()) ?? null;
}

export function getAgentActionSummary(): {
  total: number;
  bySource: Record<AgentActionSource, number>;
  byRisk: Record<AgentActionRisk, number>;
  categories: string[];
  tools: string[];
} {
  const bySource: Record<AgentActionSource, number> = { custom: 0, opencode: 0, runtime: 0, dynamic: 0 };
  const byRisk: Record<AgentActionRisk, number> = { read: 0, write: 0, external: 0, mutating: 0, destructive: 0 };
  const categories = new Set<string>();
  const tools = new Set<string>();

  for (const action of AGENT_ACTIONS) {
    bySource[action.source] += 1;
    byRisk[action.risk] += 1;
    categories.add(action.category);
    tools.add(action.tool);
  }

  return {
    total: AGENT_ACTIONS.length,
    bySource,
    byRisk,
    categories: [...categories].sort(),
    tools: [...tools].sort(),
  };
}
