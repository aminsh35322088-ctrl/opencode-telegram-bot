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
  "actions.list": { icon: "🧰", label: "List Available Actions" },
  "actions.describe": { icon: "📖", label: "Describe Action" },
  "actions.resolve": { icon: "🧭", label: "Resolve Action" },
  "actions.sources": { icon: "🔌", label: "List Action Sources" },
  "actions.summary": { icon: "📊", label: "Summarize Actions" },

  "bot.capabilities.list": { icon: "🧰", label: "List Bot Capabilities" },
  "bot.projects.list": { icon: "📂", label: "List Projects" },
  "bot.worktree.context": { icon: "🌳", label: "Inspect Worktree Context" },
  "bot.models.providers": { icon: "🔌", label: "List Model Providers" },
  "bot.models.list": { icon: "🧠", label: "List Models" },
  "bot.models.search": { icon: "🔎", label: "Search Models" },
  "bot.models.selection": { icon: "🎯", label: "Check Model Selection" },
  "bot.models.current": { icon: "🧠", label: "Check Current Model" },
  "bot.models.refresh": { icon: "🔄", label: "Refresh Model Catalog" },
  "bot.models.select": { icon: "🎯", label: "Select Model" },
  "bot.agents.list": { icon: "🤖", label: "List Agents" },
  "bot.agents.current": { icon: "🤖", label: "Check Current Agent" },
  "bot.agents.select": { icon: "🎯", label: "Select Agent" },
  "bot.variants.list": { icon: "🧩", label: "List Model Variants" },
  "bot.variants.current": { icon: "🧩", label: "Check Current Variant" },
  "bot.variants.select": { icon: "🎯", label: "Select Model Variant" },
  "bot.skills.list": { icon: "🎓", label: "List Skills" },
  "bot.skills.create": { icon: "✨", label: "Create Skill" },
  "bot.skills.update": { icon: "✏️", label: "Update Skill" },
  "bot.skills.delete": { icon: "🗑️", label: "Delete Skill" },
  "bot.skills.import": { icon: "📥", label: "Import Skill" },
  "bot.commands.list": { icon: "⌨️", label: "List Commands" },
  "bot.mcp.list": { icon: "🔌", label: "List MCP Servers" },
  "bot.mcp.add-local": { icon: "➕", label: "Add Local MCP Server" },
  "bot.mcp.add-remote": { icon: "🌐", label: "Add Remote MCP Server" },
  "bot.mcp.enable": { icon: "✅", label: "Enable MCP Server" },
  "bot.mcp.rename": { icon: "✏️", label: "Rename MCP Server" },
  "bot.mcp.delete": { icon: "🗑️", label: "Delete MCP Server" },
  "bot.session.current": { icon: "💬", label: "Check Current Session" },
  "bot.session.messages": { icon: "🧾", label: "Read Session Messages" },
  "bot.session.latest-assistant": { icon: "🤖", label: "Read Latest Assistant Reply" },
  "bot.run.status": { icon: "📊", label: "Check Agent Run Status" },
  "bot.tasks.list": { icon: "📋", label: "List Scheduled Tasks" },
  "bot.tasks.get": { icon: "🔎", label: "Inspect Scheduled Task" },
  "bot.tasks.parse": { icon: "🧩", label: "Parse Task Schedule" },
  "bot.tasks.create": { icon: "➕", label: "Create Scheduled Task" },
  "bot.tasks.delete": { icon: "🗑️", label: "Delete Scheduled Task" },
  "bot.settings.get": { icon: "⚙️", label: "Read Bot Setting" },
  "bot.settings.set": { icon: "⚙️", label: "Update Bot Setting" },
  "bot.memory.list": { icon: "🧠", label: "List Memories" },
  "bot.memory.search": { icon: "🔎", label: "Search Memory" },
  "bot.memory.add": { icon: "➕", label: "Add Memory" },
  "bot.memory.remove": { icon: "➖", label: "Remove Memory" },
  "bot.memory.clear": { icon: "🧹", label: "Clear Memory" },
  "bot.providers.list": { icon: "🔌", label: "List Custom Providers" },
  "bot.providers.get": { icon: "🔎", label: "Inspect Custom Provider" },
  "bot.providers.stt-status": { icon: "🎙️", label: "Check STT Provider Status" },
  "bot.integrations.github.list": { icon: "🐙", label: "List GitHub Integrations" },
  "bot.integrations.github.active": { icon: "🐙", label: "Check Active GitHub Integration" },
  "bot.integrations.github.select": { icon: "🎯", label: "Select GitHub Integration" },
  "bot.integrations.github.remove": { icon: "🗑️", label: "Remove GitHub Integration" },
  "bot.integrations.railway.list": { icon: "🚆", label: "List Railway Integrations" },
  "bot.integrations.railway.active": { icon: "🚆", label: "Check Active Railway Integration" },
  "bot.integrations.railway.select": { icon: "🎯", label: "Select Railway Integration" },
  "bot.integrations.railway.remove": { icon: "🗑️", label: "Remove Railway Integration" },
  "bot.version.info": { icon: "🏷️", label: "Check Bot Version" },

  "file.read": { icon: "📖", label: "Read File" },
  "file.write": { icon: "✍️", label: "Write File" },
  "file.search": { icon: "🔎", label: "Search Files" },
  "file.grep": { icon: "🔍", label: "Search File Contents" },
  "file.info": { icon: "ℹ️", label: "Inspect File Info" },
  "file.delete": { icon: "🗑️", label: "Delete File" },
  "file.copy": { icon: "📄", label: "Copy File" },
  "file.move": { icon: "📦", label: "Move File" },

  "git.status": { icon: "🌿", label: "Check Git Status" },
  "git.diff": { icon: "📝", label: "View Git Diff" },
  "git.log": { icon: "📜", label: "View Git History" },
  "git.commit": { icon: "💾", label: "Commit Changes" },
  "git.push": { icon: "⬆️", label: "Push Changes" },
  "git.pull": { icon: "⬇️", label: "Pull Changes" },
  "git.branch": { icon: "🌿", label: "Manage Git Branches" },
  "git.checkout": { icon: "🔀", label: "Switch Git Branch" },
  "git.stash": { icon: "📦", label: "Stash Changes" },
  "git.merge": { icon: "🔀", label: "Merge Git Branch" },
  "git.rebase": { icon: "🧬", label: "Rebase Git Branch" },
  "git.blame": { icon: "🕵️", label: "Inspect Git Blame" },
  "git.tags": { icon: "🏷️", label: "List Git Tags" },
  "git.remote": { icon: "🌐", label: "Inspect Git Remotes" },
  "git.fetch": { icon: "📥", label: "Fetch Git Updates" },
  "git.reset": { icon: "⏪", label: "Reset Git State" },

  "monitoring.tail": { icon: "📡", label: "Watch Live Logs" },
  "monitoring.grep": { icon: "🔎", label: "Search Monitoring Logs" },
  "monitoring.health": { icon: "💚", label: "Check Service Health" },
  "monitoring.metrics": { icon: "📊", label: "Inspect Service Metrics" },
  "monitoring.alerts": { icon: "🚨", label: "Check Service Alerts" },

  "notify.send": { icon: "📨", label: "Send Notification" },
  "notify.alert": { icon: "🚨", label: "Send Alert" },
  "notify.schedule": { icon: "⏰", label: "Schedule Notification" },
  "notify.list": { icon: "📋", label: "List Notifications" },
  "notify.cancel": { icon: "❌", label: "Cancel Notification" },

  "security.secrets": { icon: "🔐", label: "Inspect Secret Exposure" },
  "security.audit": { icon: "🛡️", label: "Run Security Audit" },
  "security.permissions": { icon: "🔑", label: "Inspect Permissions" },
  "security.deps": { icon: "🧩", label: "Audit Dependencies" },

  "session-extended.create": { icon: "➕", label: "Create Session" },
  "session-extended.delete": { icon: "🗑️", label: "Delete Session" },
  "session-extended.export": { icon: "📤", label: "Export Session" },
  "session-extended.list-all": { icon: "📚", label: "List All Sessions" },
  "session-extended.archive": { icon: "🗄️", label: "Archive Session" },

  "test.test": { icon: "🧪", label: "Run Tests" },
  "test.lint": { icon: "🧹", label: "Run Lint" },
  "test.typecheck": { icon: "🔎", label: "Run Type Check" },
  "test.build": { icon: "🏗️", label: "Build Project" },
  "test.test-file": { icon: "🧪", label: "Run File Tests" },
  "test.lint-fix": { icon: "🧹", label: "Fix Lint Issues" },

  "session-recovery.inspect": { icon: "🛟", label: "Inspect Session Recovery" },
  "session-recovery.abort": { icon: "🛑", label: "Abort Stuck Session" },
  "session-recovery.continue": { icon: "▶️", label: "Continue Recovered Session" },

  "browser.open": { icon: "🌐", label: "Open Browser" },
  "browser.goto": { icon: "🌐", label: "Open Web Page" },
  "browser.back": { icon: "⬅️", label: "Go Back" },
  "browser.forward": { icon: "➡️", label: "Go Forward" },
  "browser.reload": { icon: "🔄", label: "Reload Page" },
  "browser.snapshot": { icon: "🧾", label: "Capture Page Snapshot" },
  "browser.screenshot": { icon: "📸", label: "Take Screenshot" },
  "browser.click": { icon: "👆", label: "Click Element" },
  "browser.fill": { icon: "✍️", label: "Fill Field" },
  "browser.type": { icon: "⌨️", label: "Type Text" },
  "browser.press": { icon: "⌨️", label: "Press Key" },
  "browser.hover": { icon: "🖱️", label: "Hover Element" },
  "browser.check": { icon: "☑️", label: "Check Option" },
  "browser.uncheck": { icon: "⬜", label: "Uncheck Option" },
  "browser.select": { icon: "🔽", label: "Select Option" },
  "browser.close": { icon: "❎", label: "Close Browser" },
  "browser.tab-list": { icon: "🗂️", label: "List Browser Tabs" },
  "browser.tab-new": { icon: "➕", label: "Open New Browser Tab" },
  "browser.tab-select": { icon: "🗂️", label: "Switch Browser Tab" },
  "browser.tab-close": { icon: "❎", label: "Close Browser Tab" },
  "browser.requests": { icon: "🌐", label: "Inspect Network Requests" },
  "browser.console": { icon: "🖥️", label: "Inspect Browser Console" },
  "browser.pdf": { icon: "📄", label: "Save Page as PDF" },

  "railway.whoami": { icon: "👤", label: "Check Railway Account" },
  "railway.status": { icon: "🚦", label: "Check Railway Status" },
  "railway.logs": { icon: "📜", label: "Read Railway Logs" },
  "railway.variables": { icon: "🔐", label: "Inspect Railway Variables" },
  "railway.deploy": { icon: "🚀", label: "Deploy to Railway" },
  "railway.deploy-latest": { icon: "🚀", label: "Deploy Latest Revision" },
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
  "ssh.check": { icon: "🔐", label: "Check SSH Access" },
  "ssh.debug": { icon: "🩺", label: "Debug SSH Connection" },
  "ssh.exec": { icon: "🖥️", label: "Run SSH Command" },
  "tailscale.status": { icon: "🌐", label: "Check Tailnet Status" },
  "tailscale.devices": { icon: "🖥️", label: "List Tailnet Devices" },
  "tailscale.ping": { icon: "📡", label: "Ping Tailnet Device" },
  "ssh.upload": { icon: "📤", label: "Upload over SSH" },
  "ssh.download": { icon: "📥", label: "Download over SSH" },
};

const TOOL_META: Record<string, FriendlyActionDisplay> = {
  actions: { icon: "🧰", label: "Actions" },
  bot: { icon: "🤖", label: "Bot" },
  file: { icon: "📁", label: "File" },
  git: { icon: "🌿", label: "Git" },
  monitoring: { icon: "📊", label: "Monitoring" },
  notify: { icon: "🔔", label: "Notification" },
  security: { icon: "🛡️", label: "Security" },
  "session-extended": { icon: "🧭", label: "Session" },
  test: { icon: "🧪", label: "Tests" },
  browser: { icon: "🌐", label: "Browser" },
  "database-query": { icon: "🗃️", label: "Database" },
  "full-diagnostics": { icon: "🩺", label: "Diagnostics" },
  "github-ci": { icon: "⚙️", label: "GitHub CI" },
  "image-inspect": { icon: "👁️", label: "Image" },
  "logs-observability": { icon: "🔎", label: "Logs" },
  media: { icon: "🎬", label: "Media" },
  telegram: { icon: "💬", label: "Telegram" },
  "network-diagnostics": { icon: "🌐", label: "Network" },
  tailscale: { icon: "🌐", label: "Tailscale" },
  ssh: { icon: "🔐", label: "SSH" },
  railway: { icon: "🚆", label: "Railway" },
  "safe-download": { icon: "📥", label: "Download" },
  "send-file": { icon: "📤", label: "File" },
  session: { icon: "💬", label: "Session" },
  "session-recovery": { icon: "🛟", label: "Session Recovery" },
  "storage-health": { icon: "💾", label: "Storage" },
  "system-diagnostics": { icon: "🩺", label: "System" },
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
  archive: "Archive",
  export: "Export",
  send: "Send",
  alert: "Send Alert",
  schedule: "Schedule",
  copy: "Copy",
  move: "Move",
  query: "Query",
  fill: "Fill",
  type: "Type",
  press: "Press",
  hover: "Hover",
  check: "Check",
  uncheck: "Uncheck",
  back: "Go Back",
  forward: "Go Forward",
  reload: "Reload",
  screenshot: "Take Screenshot",
  snapshot: "Capture Snapshot",
  download: "Download",
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

function singleActionLabel(tool: string, action: string): string | null {
  const subject = TOOL_META[tool]?.label ?? titleCaseToken(tool);
  switch (action.toLowerCase()) {
    case "status": return `Check ${subject} Status`;
    case "info": return `Inspect ${subject} Info`;
    case "diff": return `View ${subject} Diff`;
    case "log": return `View ${subject} History`;
    case "logs": return `View ${subject} Logs`;
    case "health": return `Check ${subject} Health`;
    case "metrics": return `View ${subject} Metrics`;
    case "alerts": return `Check ${subject} Alerts`;
    case "variables": return `View ${subject} Variables`;
    case "jobs": return `Inspect ${subject} Jobs`;
    case "sources": return `List ${subject} Sources`;
    case "summary": return `Summarize ${subject}`;
    case "secrets": return `Inspect ${subject} Secrets`;
    case "audit": return `Audit ${subject}`;
    case "permissions": return `Inspect ${subject} Permissions`;
    case "deps": return `Audit ${subject} Dependencies`;
    case "commit": return "Commit Changes";
    case "push": return "Push Changes";
    case "pull": return "Pull Changes";
    case "branch": return "Manage Git Branches";
    case "checkout": return "Switch Git Branch";
    case "stash": return "Stash Changes";
    case "merge": return "Merge Git Branch";
    case "rebase": return "Rebase Git Branch";
    case "blame": return "Inspect Git Blame";
    case "tags": return "List Git Tags";
    case "remote": return "Inspect Git Remotes";
    case "fetch": return tool === "git" ? "Fetch Git Updates" : `Fetch ${subject}`;
    case "reset": return "Reset Git State";
    case "goto": return "Open Web Page";
    case "requests": return "Inspect Network Requests";
    case "console": return "Inspect Browser Console";
    case "pdf": return "Save Page as PDF";
    case "whoami": return "Check Railway Account";
    case "deploy-latest": return "Deploy Latest Revision";
    case "cleanup-safe": return "Clean Storage Safely";
    case "list-all": return "List All Sessions";
    case "test-file": return "Run File Tests";
    case "lint-fix": return "Fix Lint Issues";
    case "typecheck": return "Run Type Check";
    default: return null;
  }
}

function humanizeAction(tool: string, action: string): string {
  const parts = action.split(".").filter(Boolean);
  if (parts.length === 0) return `Run ${TOOL_META[tool]?.label ?? "Action"}`;

  if (parts.length === 1) {
    const single = singleActionLabel(tool, parts[0] ?? action);
    if (single) return single;
    const verb = VERBS[(parts[0] ?? "").toLowerCase()];
    if (verb) return `${verb} ${TOOL_META[tool]?.label ?? titleCaseToken(tool)}`.trim();
    return `${titleCaseToken(parts[0] ?? action)} ${TOOL_META[tool]?.label ?? ""}`.trim();
  }

  const verbToken = parts.at(-1) ?? "";
  const subjectTokens = parts.slice(0, -1);
  const verb = VERBS[verbToken.toLowerCase()];
  if (verb) {
    return `${verb} ${subjectTokens.map(titleCaseToken).join(" ")}`.trim();
  }

  if (verbToken === "current") return `Check Current ${subjectTokens.map(titleCaseToken).join(" ")}`;
  if (verbToken === "active") return `Check Active ${subjectTokens.map(titleCaseToken).join(" ")}`;
  if (verbToken === "selection") return `Check ${subjectTokens.map(titleCaseToken).join(" ")} Selection`;
  if (verbToken === "providers") return `List ${subjectTokens.map(titleCaseToken).join(" ")} Providers`;
  if (verbToken === "context") return `Inspect ${subjectTokens.map(titleCaseToken).join(" ")} Context`;
  if (verbToken === "stt-status") return `Check ${subjectTokens.map(titleCaseToken).join(" ")} STT Status`;
  if (verbToken === "info") return `Inspect ${subjectTokens.map(titleCaseToken).join(" ")} Info`;

  return parts.map(titleCaseToken).join(" ");
}

function fallbackToolLabel(tool: string): FriendlyActionDisplay {
  const normalized = tool.trim();
  if (normalized.includes("mcp")) return { icon: "🔌", label: titleCaseToken(normalized || "MCP Tool") };
  const known = TOOL_META[normalized];
  if (known) return known;
  return { icon: "🛠️", label: titleCaseToken(normalized || "Tool") };
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
      icon: TOOL_META[tool]?.icon ?? (tool.includes("mcp") ? "🔌" : "🛠️"),
      label: humanizeAction(tool, action),
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
