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
    me?: { id?: string | null; name?: string | null; email?: string | null } | null;
    project?: {
      id?: string | null;
      name?: string | null;
      services?: { edges?: Array<{ node?: { id?: string | null; name?: string | null } | null }> } | null;
      environments?: { edges?: Array<{ node?: { id?: string | null; name?: string | null } | null }> } | null;
    } | null;
    deployments?: { edges?: Array<{ node?: { id?: string | null; status?: string | null; createdAt?: string | null } | null }> } | null;
    deploymentLogs?: Array<{ timestamp?: string | null; message?: string | null; severity?: string | null }> | null;
  };
  errors?: Array<{ message?: string; extensions?: { code?: string } }>;
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

function apiHeaders(token: string, tokenType: "account" | "workspace" | "project" | null): Record<string, string> {
  return tokenType === "project"
    ? { "Project-Access-Token": token, "Content-Type": "application/json" }
    : { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function railwayApi<T extends RailwayGraphqlResponse>(token: string, tokenType: "account" | "workspace" | "project" | null, query: string, variables?: Record<string, unknown>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(RAILWAY_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: apiHeaders(token, tokenType),
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => ({}))) as T;
    if (!response.ok) throw new Error(`Railway API HTTP ${response.status}`);
    if (payload.errors?.length) throw new Error(payload.errors.map((error) => error.message ?? "GraphQL error").join("; "));
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveProjectTokenScope(token: string): Promise<ProjectTokenScope | null> {
  try {
    const payload = await railwayApi<RailwayGraphqlResponse>(token, "project", "query { projectToken { projectId environmentId } }");
    const projectToken = payload.data?.projectToken;
    if (!projectToken?.projectId || !projectToken.environmentId) return null;
    return { projectId: projectToken.projectId, environmentId: projectToken.environmentId };
  } catch {
    return null;
  }
}

async function directApiFallback(
  action: "whoami" | "status" | "logs",
  token: string,
  tokenType: "account" | "workspace" | "project" | null,
  project?: string,
  environment?: string,
  service?: string,
  deployment?: string,
  lines = 100,
): Promise<unknown> {
  if (action === "whoami") {
    const data = await railwayApi(token, tokenType, "query { me { id name email } }");
    return { ok: true, transport: "direct-api-fallback", action, output: data.data?.me ?? null };
  }

  if (!project) throw new Error("Direct API fallback requires a project ID/name for this operation.");

  if (action === "status") {
    const data = await railwayApi(
      token,
      tokenType,
      `query project($id: String!) {
        project(id: $id) {
          id name
          services { edges { node { id name } } }
          environments { edges { node { id name } } }
        }
      }`,
      { id: project },
    );
    return {
      ok: true,
      transport: "direct-api-fallback",
      action,
      project: data.data?.project ?? null,
      requestedEnvironment: environment ?? null,
      requestedService: service ?? null,
    };
  }

  if (!service) throw new Error("Direct API log fallback requires a service ID.");
  let deploymentId = deployment;
  if (!deploymentId) {
    const data = await railwayApi(
      token,
      tokenType,
      `query deployments($input: DeploymentListInput!) {
        deployments(input: $input, first: 1) {
          edges { node { id status createdAt } }
        }
      }`,
      { input: { projectId: project, serviceId: service } },
    );
    deploymentId = data.data?.deployments?.edges?.[0]?.node?.id ?? undefined;
  }
  if (!deploymentId) throw new Error("No deployment was found for the requested service.");
  const data = await railwayApi(
    token,
    tokenType,
    `query deploymentLogs($deploymentId: String!, $limit: Int) {
      deploymentLogs(deploymentId: $deploymentId, limit: $limit) { timestamp message severity }
    }`,
    { deploymentId, limit: Math.max(1, Math.min(Math.trunc(lines), 200)) },
  );
  return { ok: true, transport: "direct-api-fallback", action, deploymentId, output: data.data?.deploymentLogs ?? [] };
}

function stringifyResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export default tool({
  description: "Railway operations tool. This is the single Railway interface for the model: use it instead of shelling out to railway. Strategy is automatic: CLI is the primary transport using the active Railway API token; for safe read-only operations (whoami/status/logs), the tool can transparently fall back to the Railway GraphQL API if the CLI fails. Never retry an identical failure indefinitely. Deploy uses CLI only to prevent duplicate deployments.",
  args: {
    action: tool.schema.enum(["whoami", "status", "logs", "variables", "deploy"]).describe("One operation: whoami=verify auth; status=inspect project; logs=read finite logs; variables=list variable names; deploy=trigger a deployment."),
    project: tool.schema.string().optional().describe("Railway project name or ID. Prefer the explicit project ID for deterministic targeting."),
    environment: tool.schema.string().optional().describe("Railway environment name or ID."),
    service: tool.schema.string().optional().describe("Railway service name or ID. For direct API log fallback, use the service ID."),
    deployment: tool.schema.string().optional().describe("Optional deployment ID for logs; if omitted, the latest deployment is selected when API fallback is needed."),
    lines: tool.schema.number().optional().describe("For logs only: finite historical lines, clamped to 1-200."),
    build: tool.schema.boolean().optional().describe("For logs only: read build logs instead of runtime logs."),
    timeoutMs: tool.schema.number().optional().describe("CLI timeout in milliseconds, 3000-120000."),
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
      const scope = await resolveProjectTokenScope(token);
      project ??= scope?.projectId;
      environment ??= scope?.environmentId;
      if (!project || !environment) {
        return stringifyResult({ ok: false, action: args.action, error: "PROJECT_SCOPE_UNRESOLVED", message: "The selected Railway project token is present, but its project/environment scope could not be resolved." });
      }
    }

    const command: string[] = [];
    switch (args.action) {
      case "whoami": command.push("whoami", "--json"); break;
      case "status": command.push("status", "--json"); addScope(command, project, environment, args.service); break;
      case "logs":
        command.push("logs");
        if (args.deployment?.trim()) command.push(args.deployment.trim());
        addScope(command, project, environment, args.service);
        if (args.build) command.push("--build");
        command.push("--lines", String(Math.max(1, Math.min(Math.trunc(args.lines ?? 100), 200))), "--json");
        break;
      case "variables": command.push("variable", "list", "--json"); addScope(command, project, environment, args.service); break;
      case "deploy": command.push("up", "--detach", "--yes"); addScope(command, project, environment, args.service); break;
    }

    const railwayEnv: NodeJS.ProcessEnv = { ...process.env };
    delete railwayEnv.RAILWAY_TOKEN;
    delete railwayEnv.RAILWAY_API_TOKEN;
    if (tokenType === "project") railwayEnv.RAILWAY_TOKEN = token;
    else railwayEnv.RAILWAY_API_TOKEN = token;

    const startedAt = Date.now();
    console.info(`[RailwayTool] start transport=cli action=${args.action} account=${account?.name ?? "Unknown"} tokenType=${tokenType ?? "unknown"} project=${project ?? "-"} environment=${environment ?? "-"} service=${args.service?.trim() ?? "-"}`);

    try {
      const { stdout, stderr } = await execFileAsync(RAILWAY_BIN, command, {
        cwd: context.worktree,
        timeout: clampTimeout(args.timeoutMs),
        maxBuffer: 2 * 1024 * 1024,
        env: railwayEnv,
      });
      const output = `${stdout.trim()}${stderr.trim() ? `\n${stderr.trim()}` : ""}`.trim();
      const durationMs = Date.now() - startedAt;
      console.info(`[RailwayTool] success transport=cli action=${args.action} durationMs=${durationMs}`);
      return stringifyResult({ ok: true, transport: "cli", account: account?.name ?? "Unknown", tokenType: tokenType ?? "unknown", project: project ?? null, environment: environment ?? null, service: args.service?.trim() ?? null, action: args.action, command: `railway ${command.join(" ")}`, durationMs, output: redact(output, token).slice(-MAX_OUTPUT) });
    } catch (error) {
      const e = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string; signal?: string };
      const stdout = typeof e.stdout === "string" ? e.stdout : "";
      const stderr = typeof e.stderr === "string" ? e.stderr : "";
      const cliOutput = redact(`${stdout}${stderr ? `\n${stderr}` : ""}`.trim(), token).slice(-MAX_OUTPUT);
      const durationMs = Date.now() - startedAt;
      console.error(`[RailwayTool] failure transport=cli action=${args.action} durationMs=${durationMs} code=${e.code ?? "unknown"}`);

      if (["whoami", "status", "logs"].includes(args.action)) {
        try {
          console.info(`[RailwayTool] fallback transport=direct-api action=${args.action}`);
          const fallback = await directApiFallback(args.action, token, tokenType, project, environment, args.service?.trim(), args.deployment?.trim(), args.lines ?? 100);
          console.info(`[RailwayTool] success transport=direct-api action=${args.action} durationMs=${Date.now() - startedAt}`);
          return stringifyResult({ ...fallback as Record<string, unknown>, cliFailure: { exitCode: e.code ?? null, signal: e.signal ?? null, output: cliOutput } });
        } catch (fallbackError) {
          const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          console.error(`[RailwayTool] failure transport=direct-api action=${args.action} message=${fallbackMessage}`);
          return stringifyResult({ ok: false, transport: "cli+direct-api", account: account?.name ?? "Unknown", tokenType: tokenType ?? "unknown", project: project ?? null, environment: environment ?? null, service: args.service?.trim() ?? null, action: args.action, durationMs: Date.now() - startedAt, exitCode: e.code ?? null, signal: e.signal ?? null, cliOutput, fallbackError: fallbackMessage, hint: "Correct the target or credentials before retrying; do not repeat an identical failed call indefinitely." });
        }
      }

      return stringifyResult({ ok: false, transport: "cli", account: account?.name ?? "Unknown", tokenType: tokenType ?? "unknown", project: project ?? null, environment: environment ?? null, service: args.service?.trim() ?? null, action: args.action, command: `railway ${command.join(" ")}`, durationMs, exitCode: e.code ?? null, signal: e.signal ?? null, output: cliOutput, hint: "Deploy is CLI-only to prevent duplicate deployments. Correct the target or arguments before retrying." });
    }
  },
});
