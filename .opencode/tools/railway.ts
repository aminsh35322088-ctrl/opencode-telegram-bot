import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tool } from "@opencode-ai/plugin";
import { pathToFileURL } from "node:url";

interface RailwayIntegrationStore {
  getRailwayToken(): Promise<string>;
  getActiveRailwayTokenType(): Promise<"account" | "workspace" | "project" | null>;
  getActiveRailwayAccount(): Promise<{ name: string } | null>;
}

interface ProjectTokenScope {
  projectId: string;
  environmentId: string;
}

interface RailwayGraphqlResponse {
  data?: {
    projectToken?: { projectId?: string | null; environmentId?: string | null } | null;
  };
}

const execFileAsync = promisify(execFile);
const RAILWAY_BIN = "/usr/local/bin/railway";
const RAILWAY_GRAPHQL_ENDPOINT = "https://backboard.railway.com/graphql/v2";
const MAX_OUTPUT = 16000;
const DEFAULT_TIMEOUT_MS = 15000;
const STORE_PATH = "/app/dist/app/services/railway-integration-service.js";

async function getStore(): Promise<RailwayIntegrationStore> {
  return import(pathToFileURL(STORE_PATH).href) as Promise<RailwayIntegrationStore>;
}

function clampTimeout(value?: number): number {
  return Math.max(3000, Math.min(Math.trunc(value ?? DEFAULT_TIMEOUT_MS), 120000));
}

function redact(text: string, token: string): string {
  return token ? text.split(token).join("[REDACTED]") : text;
}

function addScope(args: string[], project?: string, environment?: string, service?: string): void {
  if (project?.trim()) args.push("--project", project.trim());
  if (environment?.trim()) args.push("--environment", environment.trim());
  if (service?.trim()) args.push("--service", service.trim());
}

async function resolveProjectTokenScope(token: string): Promise<ProjectTokenScope | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(RAILWAY_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: { "Project-Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "query { projectToken { projectId environmentId } }" }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const payload = (await response.json().catch(() => ({}))) as RailwayGraphqlResponse;
    const projectToken = payload.data?.projectToken;
    if (!projectToken?.projectId || !projectToken.environmentId) return null;
    return { projectId: projectToken.projectId, environmentId: projectToken.environmentId };
  } finally {
    clearTimeout(timer);
  }
}

function stringifyResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export default tool({
  description: "Railway operations tool. Use this tool for Railway status, logs, variables, authentication, and deployments instead of running the Railway CLI through the shell. Prefer explicit project/environment/service when targeting a resource. Each call performs exactly one Railway operation and returns structured success or failure data."
  ,args: {
    action: tool.schema.enum(["whoami", "status", "logs", "variables", "deploy"]).describe("One Railway operation: whoami=verify account auth; status=inspect project/services; logs=read deploy or build logs; variables=list service variables; deploy=trigger railway up."),
    project: tool.schema.string().optional().describe("Railway project name or ID. Required for unlinked operations when the selected credential is project-scoped; omit only when the CLI can safely infer the target."),
    environment: tool.schema.string().optional().describe("Railway environment name or ID. Use with project for deterministic targeting."),
    service: tool.schema.string().optional().describe("Railway service name or ID. Use when the action targets one service."),
    lines: tool.schema.number().optional().describe("For logs only: number of historical log lines, clamped to 1-200."),
    build: tool.schema.boolean().optional().describe("For logs only: read build logs instead of deploy/runtime logs."),
    timeoutMs: tool.schema.number().optional().describe("CLI timeout in milliseconds, 3000-120000. Use the default for normal status/log operations."),
  },
  async execute(args, context) {
    const store = await getStore();
    const token = await store.getRailwayToken();
    if (!token) {
      return stringifyResult({ ok: false, action: args.action, error: "NO_RAILWAY_CREDENTIAL", message: "No active Railway account is configured. Add/select a Railway account in Integrations first." });
    }

    const account = await store.getActiveRailwayAccount();
    const tokenType = await store.getActiveRailwayTokenType();
    let project = args.project?.trim();
    let environment = args.environment?.trim();

    if (tokenType === "project" && (!project || !environment)) {
      const scope = await resolveProjectTokenScope(token).catch(() => null);
      project ??= scope?.projectId;
      environment ??= scope?.environmentId;
      if (!project || !environment) {
        return stringifyResult({ ok: false, action: args.action, error: "PROJECT_SCOPE_UNRESOLVED", message: "The selected Railway project token is present, but its project/environment scope could not be resolved." });
      }
    }

    const command: string[] = [];
    switch (args.action) {
      case "whoami":
        command.push("whoami", "--json");
        break;
      case "status":
        // Railway's documented status command already returns the full linked
        // environment overview. Explicit scope flags make it independent of cwd.
        command.push("status", "--json");
        addScope(command, project, environment, args.service);
        break;
      case "logs":
        command.push("logs");
        addScope(command, project, environment, args.service);
        if (args.build) command.push("--build");
        command.push("--lines", String(Math.max(1, Math.min(Math.trunc(args.lines ?? 100), 200))), "--json");
        break;
      case "variables":
        command.push("variable", "list", "--json");
        addScope(command, project, environment, args.service);
        break;
      case "deploy":
        command.push("up", "--detach", "--yes");
        addScope(command, project, environment, args.service);
        break;
    }

    const railwayEnv: NodeJS.ProcessEnv = { ...process.env };
    delete railwayEnv.RAILWAY_TOKEN;
    delete railwayEnv.RAILWAY_API_TOKEN;
    if (tokenType === "project") railwayEnv.RAILWAY_TOKEN = token;
    else railwayEnv.RAILWAY_API_TOKEN = token;

    const startedAt = Date.now();
    logger.info?.(`[RailwayTool] start action=${args.action} account=${account?.name ?? "Unknown"} tokenType=${tokenType ?? "unknown"} project=${project ?? "-"} environment=${environment ?? "-"} service=${args.service?.trim() ?? "-"}`);

    try {
      const { stdout, stderr } = await execFileAsync(RAILWAY_BIN, command, {
        cwd: context.worktree,
        timeout: clampTimeout(args.timeoutMs),
        maxBuffer: 2 * 1024 * 1024,
        env: railwayEnv,
      });
      const output = `${stdout.trim()}${stderr.trim() ? `\n${stderr.trim()}` : ""}`.trim();
      logger.info?.(`[RailwayTool] success action=${args.action} durationMs=${Date.now() - startedAt}`);
      return stringifyResult({
        ok: true,
        account: account?.name ?? "Unknown",
        tokenType: tokenType ?? "unknown",
        project: project ?? null,
        environment: environment ?? null,
        service: args.service?.trim() ?? null,
        action: args.action,
        command: `railway ${command.join(" ")}`,
        durationMs: Date.now() - startedAt,
        output: redact(output, token).slice(-MAX_OUTPUT),
      });
    } catch (error) {
      const e = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string; signal?: string };
      const stdout = typeof e.stdout === "string" ? e.stdout : "";
      const stderr = typeof e.stderr === "string" ? e.stderr : "";
      const output = redact(`${stdout}${stderr ? `\n${stderr}` : ""}`.trim(), token).slice(-MAX_OUTPUT);
      logger.error?.(`[RailwayTool] failure action=${args.action} durationMs=${Date.now() - startedAt} code=${e.code ?? "unknown"}`);
      return stringifyResult({
        ok: false,
        account: account?.name ?? "Unknown",
        tokenType: tokenType ?? "unknown",
        project: project ?? null,
        environment: environment ?? null,
        service: args.service?.trim() ?? null,
        action: args.action,
        command: `railway ${command.join(" ")}`,
        durationMs: Date.now() - startedAt,
        exitCode: e.code ?? null,
        signal: e.signal ?? null,
        output,
        hint: "Use the returned error/output to correct the target or arguments before retrying; do not repeat an identical failed call indefinitely.",
      });
    }
  },
});