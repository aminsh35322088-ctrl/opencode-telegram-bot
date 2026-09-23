import type { AgentActionDefinition } from "../services/agent-action-registry.js";

export interface FriendlyActionDisplay {
  icon: string;
  label: string;
}

const CORE_LABELS: Record<string, FriendlyActionDisplay> = {
  read: { icon: "📖", label: "Read File" },
  write: { icon: "✍️", label: "Write File" },
  edit: { icon: "✏️", label: "Edit File" },
  apply_patch: { icon: "🩹", label: "Apply Patch" },
  bash: { icon: "💻", label: "Run Command" },
  grep: { icon: "🔍", label: "Search Text" },
  glob: { icon: "📁", label: "Find Files" },
  webfetch: { icon: "🌐", label: "Fetch Web Page" },
  websearch: { icon: "🔎", label: "Search Web" },
  lsp: { icon: "🧭", label: "Code Intelligence" },
  todowrite: { icon: "📝", label: "Update Tasks" },
  task: { icon: "🤖", label: "Delegate Task" },
  question: { icon: "❓", label: "Ask Question" },
  skill: { icon: "🎓", label: "Load Skill" },
};

const ACTION_OVERRIDES: Record<string, FriendlyActionDisplay> = {
  "media.stt.status": { icon: "🎙️", label: "Check Speech-to-Text" },
  "media.stt.transcribe": { icon: "🎙️", label: "Transcribe Audio" },
  "media.video.prepare": { icon: "🎞️", label: "Prepare Video" },
  "media.image.providers": { icon: "🔌", label: "List Image Providers" },
  "media.image.models": { icon: "🎨", label: "List Image Models" },
  "media.image.current": { icon: "👁️", label: "Check Image Setup" },
  "media.image.generate": { icon: "🖼️", label: "Generate Image" },
  "media.image.edit": { icon: "✨", label: "Edit Image" },
  "image-inspect.inspect": { icon: "👁️", label: "Inspect Image" },

  "telegram.context.current": { icon: "💬", label: "Check Telegram Context" },
  "telegram.reply.resolve": { icon: "↩️", label: "Inspect Replied Message" },
  "telegram.forward.inspect": { icon: "↪️", label: "Inspect Forwarded Message" },
  "telegram.media.fetch": { icon: "📥", label: "Fetch Telegram Media" },

  "github-ci.status": { icon: "⚙️", label: "Check CI Status" },
  "github-ci.jobs": { icon: "🧩", label: "Inspect CI Jobs" },
  "github-ci.dispatch": { icon: "🚀", label: "Start CI Workflow" },
  "github-ci.watch": { icon: "👀", label: "Watch CI Run" },
  "github-ci.logs": { icon: "📜", label: "Read CI Logs" },
  "github-ci.verify": { icon: "✅", label: "Verify CI Run" },
  "github-ci.rerun-failed": { icon: "🔄", label: "Rerun Failed CI Jobs" },
  "github-ci.cancel": { icon: "⏹️", label: "Cancel CI Run" },

  "session.current": { icon: "💬", label: "Check Current Session" },
  "session.messages": { icon: "🧾", label: "Read Session Messages" },
  "session.latest-assistant": { icon: "🤖", label: "Read Latest Assistant Reply" },
  "session.fork": { icon: "🌿", label: "Fork Session" },
  "session.revert": { icon: "↩️", label: "Revert Session" },
  "session.unrevert": { icon: "↪️", label: "Restore Reverted Session" },
  "session.summarize": { icon: "📝", label: "Summarize Session" },
  "session.abort": { icon: "🛑", label: "Abort Session" },
  "session.diff": { icon: "📝", label: "Inspect Session Changes" },
  "session.todo": { icon: "📋", label: "Inspect Session Tasks" },
  "session.children": { icon: "🌿", label: "Inspect Child Sessions" },

  "safe-download.download": { icon: "📥", label: "Download File Safely" },
  "send-file.send": { icon: "📤", label: "Send File" },
  "database-query.query": { icon: "🗃️", label: "Query Database" },
  "logs-observability.search": { icon: "🔎", label: "Search Logs" },
  "storage-health.inspect": { icon: "💾", label: "Inspect Storage" },
  "storage-health.cleanup-safe": { icon: "🧹", label: "Clean Storage Safely" },
  "system-diagnostics.summary": { icon: "🩺", label: "Check System Health" },
  "system-diagnostics.processes": { icon: "⚙️", label: "Inspect Processes" },
  "system-diagnostics.disk": { icon: "💽", label: "Inspect Disk" },
  "full-diagnostics.quick": { icon: "🩺", label: "Run Quick Diagnostics" },
  "full-diagnostics.full": { icon: "🧪", label: "Run Full Diagnostics" },
  "network-diagnostics.dns": { icon: "🌐", label: "Check DNS" },
  "network-diagnostics.http": { icon: "🌐", label: "Check HTTP" },
  "network-diagnostics.tcp": { icon: "🔌", label: "Check TCP" },

  "ssh.status": { icon: "🔌", label: "Check SSH Client" },
  "ssh.key.ensure": { icon: "🔑", label: "Prepare SSH Key" },
  "ssh.key.public": { icon: "🔑", label: "Show SSH Public Key" },
  "ssh.exec": { icon: "🖥️", label: "Run on Server" },
  "ssh.read": { icon: "📖", label: "Read Remote File" },
  "ssh.write": { icon: "✍️", label: "Write Remote File" },
  "ssh.upload": { icon: "📤", label: "Upload to Server" },
  "ssh.download": { icon: "📥", label: "Download from Server" },
};

const TOOL_ICONS: Record<string, string> = {
  actions: "🧰",
  bot: "🤖",
  browser: "🌐",
  "database-query": "🗃️",
  "full-diagnostics": "🩺",
  "github-ci": "⚙️",
  "image-inspect": "👁️",
  "logs-observability": "🔎",
  media: "🎬",
  telegram: "💬",
  "network-diagnostics": "🌐",
  railway: "🚆",
  ssh: "🔐",
  "safe-download": "📥",
  "send-file": "📤",
  session: "💬",
  "session-recovery": "🛟",
  "storage-health": "💾",
  "system-diagnostics": "🩺",
};

const VERBS: Record<string, string> = {
  list: "List",
  get: "Get",
  current: "Check Current",
  status: "Check",
  search: "Search",
  select: "Select",
  refresh: "Refresh",
  create: "Create",
  update: "Update",
  delete: "Delete",
  import: "Import",
  add: "Add",
  remove: "Remove",
  enable: "Enable",
  disable: "Disable",
  inspect: "Inspect",
  resolve: "Resolve",
  describe: "Describe",
  read: "Read",
  write: "Write",
  open: "Open",
  close: "Close",
  connect: "Connect",
  disconnect: "Disconnect",
  capture: "Capture",
  restart: "Restart",
  cleanup: "Clean",
  deploy: "Deploy",
  verify: "Verify",
  watch: "Watch",
  cancel: "Cancel",
};

function titleCaseToken(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "ci") return "CI";
      if (lower === "mcp") return "MCP";
      if (lower === "stt") return "STT";
      if (lower === "dns") return "DNS";
      if (lower === "http") return "HTTP";
      if (lower === "tcp") return "TCP";
      if (lower === "github") return "GitHub";
      if (lower === "railway") return "Railway";
      return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
}

function humanizeAction(action: string): string {
  const parts = action.split(".").filter(Boolean);
  if (parts.length === 0) return "Run Action";
  if (parts.length === 1) return titleCaseToken(parts[0] ?? action);

  const verbToken = parts.at(-1) ?? "";
  const subject = parts.slice(0, -1).map(titleCaseToken).join(" ");
  const verb = VERBS[verbToken.toLowerCase()];
  return verb ? `${verb} ${subject}`.trim() : parts.map(titleCaseToken).join(" ");
}

function fallbackToolLabel(tool: string): FriendlyActionDisplay {
  const normalized = tool.trim();
  const icon = normalized.includes("mcp") ? "🔌" : (TOOL_ICONS[normalized] ?? "🛠️");
  return { icon, label: titleCaseToken(normalized || "Tool") };
}

export function getFriendlyActionDisplay(tool: string, input?: Record<string, unknown>): FriendlyActionDisplay {
  const core = CORE_LABELS[tool];
  if (core) return core;

  const action = typeof input?.action === "string" ? input.action.trim() : "";
  if (action) {
    const id = `${tool}.${action}`;
    const override = ACTION_OVERRIDES[id];
    if (override) return override;
    return {
      icon: TOOL_ICONS[tool] ?? (tool.includes("mcp") ? "🔌" : "🛠️"),
      label: humanizeAction(action),
    };
  }

  return fallbackToolLabel(tool);
}

/** Contract helper used by registry tests to guarantee every static action gets a friendly label. */
export function getFriendlyAgentActionDisplay(action: Pick<AgentActionDefinition, "tool" | "action" | "invocation">): FriendlyActionDisplay {
  return action.invocation.kind === "action-tool"
    ? getFriendlyActionDisplay(action.tool, { action: action.action })
    : getFriendlyActionDisplay(action.tool);
}
