import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tool } from "@opencode-ai/plugin";
import { getActiveRailwayAccount, getRailwayToken } from "../../dist/app/services/railway-integration-service.js";

const execFileAsync = promisify(execFile);
const RAILWAY_BIN = "/usr/local/bin/railway";
const MAX_OUTPUT = 16000;
const DEFAULT_TIMEOUT_MS = 30000;

function clampTimeout(value?: number): number {
  return Math.max(3000, Math.min(value ?? DEFAULT_TIMEOUT_MS, 120000));
}

function redact(text: string, token: string): string {
  return text.split(token).join("[REDACTED]");
}

function addScope(args: string[], project?: string, environment?: string, service?: string): void {
  if (project?.trim()) args.push("--project", project.trim());
  if (environment?.trim()) args.push("--environment", environment.trim());
  if (service?.trim()) args.push("--service", service.trim());
}

export default tool({
  description: "Manage the currently selected Railway account from the bot. Uses the account's stored token only for the child Railway CLI process; never mutates process.env. Supports identity, project/service status, logs, variables, and deploy.",
  args: {
    action: tool.schema.enum(["whoami", "status", "logs", "variables", "deploy"]).describe("Railway operation."),
    project: tool.schema.string().optional().describe("Railway project ID. Recommended when the working directory is not linked."),
    environment: tool.schema.string().optional().describe("Railway environment name or ID."),
    service: tool.schema.string().optional().describe("Railway service name or ID."),
    lines: tool.schema.number().optional().describe("For logs: number of historical lines, 1-200."),
    build: tool.schema.boolean().optional().describe("For logs: return build logs instead of deploy logs."),
    timeoutMs: tool.schema.number().optional().describe("Command timeout, 3000-120000 ms."),
  },
  async execute(args) {
    const token = await getRailwayToken();
    if (!token) throw new Error("No active Railway account is configured. Add/select a Railway account in Integrations first.");

    const account = await getActiveRailwayAccount();
    const command: string[] = [];

    switch (args.action) {
      case "whoami":
        command.push("whoami");
        break;
      case "status":
        command.push("status", "--json");
        addScope(command, args.project, args.environment, args.service);
        break;
      case "logs": {
        command.push("logs");
        addScope(command, args.project, args.environment, args.service);
        if (args.build) command.push("--build");
        command.push("--lines", String(Math.max(1, Math.min(Math.trunc(args.lines ?? 100), 200))), "--json");
        break;
      }
      case "variables":
        command.push("variable", "list", "--json");
        addScope(command, args.project, args.environment, args.service);
        break;
      case "deploy":
        command.push("up", "--detach", "--yes");
        addScope(command, args.project, args.environment, args.service);
        break;
    }

    try {
      const { stdout, stderr } = await execFileAsync(RAILWAY_BIN, command, {
        cwd: process.env.OPENCODE_TELEGRAM_HOME || process.cwd(),
        timeout: clampTimeout(args.timeoutMs),
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, RAILWAY_TOKEN: token, RAILWAY_API_TOKEN: undefined },
      });
      const output = `${stdout.trim()}${stderr.trim() ? `\n${stderr.trim()}` : ""}`;
      return JSON.stringify({
        ok: true,
        account: account?.name ?? "Unknown",
        action: args.action,
        command: `railway ${command.join(" ")}`,
        output: redact(output, token).slice(-MAX_OUTPUT),
      }, null, 2);
    } catch (error) {
      const e = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
      const stdout = typeof e.stdout === "string" ? e.stdout : "";
      const stderr = typeof e.stderr === "string" ? e.stderr : "";
      return JSON.stringify({
        ok: false,
        account: account?.name ?? "Unknown",
        action: args.action,
        command: `railway ${command.join(" ")}`,
        exitCode: e.code ?? null,
        output: redact(`${stdout}${stderr ? `\n${stderr}` : ""}`.trim(), token).slice(-MAX_OUTPUT),
      }, null, 2);
    }
  },
});
