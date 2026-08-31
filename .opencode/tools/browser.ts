import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { tool } from "@opencode-ai/plugin";

const execFileAsync = promisify(execFile);
const ALLOWED_ACTIONS = new Set([
  "open", "goto", "back", "forward", "reload", "snapshot", "screenshot",
  "click", "fill", "type", "press", "hover", "check", "uncheck", "select",
  "close", "tab-list", "tab-new", "tab-select", "tab-close", "requests",
  "console", "pdf",
]);

function sessionArgs(session?: string): string[] {
  return session?.trim() ? [`-s=${session.trim()}`] : [];
}

export default tool({
  description:
    "Control a real headless browser through Playwright CLI. Use for JavaScript-heavy websites, UI inspection, clicks, forms, screenshots, PDFs, tabs, console/network inspection, and browser-based testing. Prefer snapshot before interacting so element refs are current.",
  args: {
    action: tool.schema.string().describe("Browser action: open, goto, snapshot, screenshot, click, fill, type, press, hover, check, uncheck, select, close, tab-list, tab-new, tab-select, tab-close, requests, console, pdf, back, forward, reload."),
    url: tool.schema.string().optional().describe("URL for open/goto/tab-new."),
    ref: tool.schema.string().optional().describe("Element ref or selector for click/fill/hover/check/uncheck/select/screenshot."),
    text: tool.schema.string().optional().describe("Text/value for fill/type/select/press."),
    filename: tool.schema.string().optional().describe("Output filename for screenshot or PDF, relative to the worktree."),
    session: tool.schema.string().optional().describe("Named Playwright session for persistent browser state."),
  },
  async execute(args, context) {
    if (!ALLOWED_ACTIONS.has(args.action)) throw new Error(`Unsupported browser action: ${args.action}`);
    const command: string[] = [...sessionArgs(args.session)];
    command.push(args.action);

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

    if ((args.action === "screenshot" || args.action === "pdf") && args.filename) {
      const output = path.resolve(context.worktree, args.filename);
      await fs.mkdir(path.dirname(output), { recursive: true });
      command.push(`--filename=${output}`);
    }

    const { stdout, stderr } = await execFileAsync("playwright-cli", command, {
      cwd: context.worktree,
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || "/data/.cache/ms-playwright",
      },
      maxBuffer: 2 * 1024 * 1024,
      timeout: 120_000,
    });

    return [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  },
});
