import type { ToolProcessPort } from "@opencode-telegram/native-runtime";
import { tool } from "@opencode-ai/plugin";

const BROWSER_ACTIONS = [
  "open", "goto", "back", "forward", "reload", "snapshot", "screenshot",
  "click", "fill", "type", "press", "hover", "check", "uncheck", "select",
  "close", "tab-list", "tab-new", "tab-select", "tab-close", "requests",
  "console", "pdf",
] as const;
const ALLOWED_ACTIONS = new Set<string>(BROWSER_ACTIONS);


export default tool({
  description:
    "Control a real headless browser through Playwright CLI. Every capability is an explicit action. Use snapshot before interacting so element refs are current.",
  args: {
    action: tool.schema.enum(BROWSER_ACTIONS).describe("Browser action to execute."),
    url: tool.schema.string().optional().describe("URL for open/goto/tab-new."),
    ref: tool.schema.string().optional().describe("Element ref or selector for click/fill/hover/check/uncheck/select/screenshot."),
    text: tool.schema.string().optional().describe("Text/value for fill/type/select/press."),
    filename: tool.schema.string().optional().describe("Output filename for screenshot or PDF, relative to the worktree."),
    session: tool.schema.string().optional().describe("Named Playwright session for persistent browser state."),
  },
  async execute(args, context) {
    if (!ALLOWED_ACTIONS.has(args.action)) throw new Error(`Unsupported browser action: ${args.action}`);
    const processPort = (context as typeof context & { process?: ToolProcessPort }).process;
    if (!processPort) throw new Error("Core browser capability is required for tool ownership.");
    const command: string[] = [];

    if (["open", "goto", "tab-new"].includes(args.action)) {
      if (!args.url) throw new Error(`${args.action} requires url`);
      command.push(args.url);
    } else if (["click", "hover", "check", "uncheck", "screenshot"].includes(args.action)) {
      if (args.ref) command.push(args.ref);
    } else if (args.action === "fill" || args.action === "select") {
      if (!args.ref || args.text === undefined) throw new Error(`${args.action} requires ref and text`);
      command.push(args.ref, args.text);
    } else if (args.action === "type" || args.action === "press") {
      if (args.text === undefined) throw new Error(`${args.action} requires text`);
      command.push(args.text);
    } else if (args.action === "tab-select" || args.action === "tab-close") {
      if (!args.text) throw new Error(`${args.action} requires tab index`);
      command.push(args.text);
    }


    try {
      const { stdout, stderr } = await processPort.browser({
        session: args.session?.trim() || undefined,
        action: args.action,
        args: command,
        filename: ["screenshot", "pdf"].includes(args.action) ? args.filename : undefined,
        maxBuffer: 2 * 1024 * 1024,
        timeout: 120_000,
      });

      return [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    } catch (error) {
      const e = error as { stderr?: string; message?: string; code?: string | number };
      if (e.code === "ENOENT") throw new Error("playwright-cli is not installed. Install it with: npm install -g playwright-cli");
      throw new Error(e.stderr || e.message || "Browser command failed");
    }
  },
});
