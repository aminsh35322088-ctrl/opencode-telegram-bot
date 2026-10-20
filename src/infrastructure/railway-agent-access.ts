type RailwayAction = "workspace" | "projects" | "project" | "service-instance" | "deployments" | "logs";

type RailwayRequest = <T>(document: string, variables?: Record<string, unknown>) => Promise<T>;
type Input = {
  action?: unknown;
  projectId?: unknown;
  serviceId?: unknown;
  environmentId?: unknown;
  deploymentId?: unknown;
  limit?: unknown;
};
type ProjectSummary = { id: string; name: string; description?: string | null };
type ProjectWithResources = ProjectSummary & {
  services: { edges: Array<{ node: { id: string; name: string } }> };
  environments: { edges: Array<{ node: { id: string; name: string } }> };
};
type Deployment = { id: string; status: string; createdAt: string };

const ID = /^[A-Za-z0-9_-]{1,256}$/u;
const MAX_OUTPUT = 24_000;

function requiredId(value: unknown, name: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(`Railway ${name} is required`);
  return value;
}

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/(bearer\\s+)[A-Za-z0-9._~+/-]+=*/giu, "$1[REDACTED]")
      .replace(/((?:token|secret|password|api[_-]?key|authorization)\\s*[:=]\\s*)["']?[^\\s"',;}]+/giu, "$1[REDACTED]")
      .replace(/(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|tskey-[A-Za-z0-9-]{20,}|railway_[A-Za-z0-9_-]{20,})/gu, "[REDACTED]");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      /^(?:value|secret|token|password|apiKey|authorization)$/iu.test(key) ? "[REDACTED]" : redact(item),
    ]));
  }
  return value;
}

function bounded(value: unknown): unknown {
  const safe = redact(value);
  const serialized = JSON.stringify(safe);
  if (serialized.length <= MAX_OUTPUT) return safe;
  return { truncated: true, message: "Railway response exceeded the output limit; narrow the query and retry.", size: serialized.length };
}

/**
 * Narrow read-only Railway API for Topic Workers. The caller never supplies GraphQL;
 * every query is fixed here, scoped to the Control Plane's selected workspace, and
 * checked against project/service/deployment ownership before returning data.
 */
export async function runRailwayAgentAccess(request: RailwayRequest, workspaceIdValue: unknown, inputValue: unknown): Promise<unknown> {
  const workspaceId = requiredId(workspaceIdValue, "workspace is not configured");
  if (!inputValue || typeof inputValue !== "object" || Array.isArray(inputValue)) throw new Error("Invalid Railway tool request");
  const input = inputValue as Input;
  const allowedKeys = new Set(["action", "projectId", "serviceId", "environmentId", "deploymentId", "limit"]);
  if (Object.keys(input).some(key => !allowedKeys.has(key))) throw new Error("Unexpected Railway tool argument");
  const actions: RailwayAction[] = ["workspace", "projects", "project", "service-instance", "deployments", "logs"];
  if (typeof input.action !== "string" || !actions.includes(input.action as RailwayAction)) throw new Error("Unsupported Railway action");
  const action = input.action as RailwayAction;

  if (action === "workspace") {
    const result = await request<{ workspace: { id: string; name: string } | null }>(
      "query WorkerRailwayWorkspace($workspaceId:String!){workspace(workspaceId:$workspaceId){id name}}",
      { workspaceId },
    );
    if (!result.workspace || result.workspace.id !== workspaceId) throw new Error("Railway workspace is unavailable");
    return bounded({ action, workspace: result.workspace, access: "read-only" });
  }

  const projectsResult = await request<{ projects: { edges: Array<{ node: ProjectSummary }> } }>(
    "query WorkerRailwayProjects($workspaceId:String!){projects(workspaceId:$workspaceId){edges{node{id name description}}}}",
    { workspaceId },
  );
  const projects = projectsResult.projects?.edges?.map(edge => edge.node) ?? [];
  if (projects.length > 200) throw new Error("Railway workspace has too many projects for one request");

  if (action === "projects") return bounded({ action, workspaceId, projects, access: "read-only" });

  const projectId = requiredId(input.projectId, "projectId");
  if (!projects.some(project => project.id === projectId)) throw new Error("Railway project is outside the configured workspace");
  const projectResult = await request<{ project: ProjectWithResources | null }>(
    "query WorkerRailwayProject($id:String!){project(id:$id){id name description services{edges{node{id name}}} environments{edges{node{id name}}}}}",
    { id: projectId },
  );
  const project = projectResult.project;
  if (!project || project.id !== projectId) throw new Error("Railway project is unavailable");

  if (action === "project") return bounded({ action, project, access: "read-only" });

  const serviceId = requiredId(input.serviceId, "serviceId");
  if (!project.services.edges.some(edge => edge.node.id === serviceId)) throw new Error("Railway service is outside the selected project");

  if (action === "service-instance") {
    const environmentId = requiredId(input.environmentId, "environmentId");
    if (!project.environments.edges.some(edge => edge.node.id === environmentId)) throw new Error("Railway environment is outside the selected project");
    const result = await request<{ serviceInstance: unknown }>(
      "query WorkerRailwayServiceInstance($serviceId:String!,$environmentId:String!){serviceInstance(serviceId:$serviceId,environmentId:$environmentId){id serviceName startCommand buildCommand rootDirectory healthcheckPath region numReplicas restartPolicyType restartPolicyMaxRetries latestDeployment{id status createdAt}}}",
      { serviceId, environmentId },
    );
    if (!result.serviceInstance) throw new Error("Railway service instance is unavailable in that environment");
    return bounded({ action, projectId, serviceId, environmentId, serviceInstance: result.serviceInstance, access: "read-only" });
  }

  const rawLimit = input.limit === undefined ? 10 : input.limit;
  if (typeof rawLimit !== "number" || !Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
    throw new Error("Railway limit must be an integer between 1 and 100");
  }
  const deploymentsResult = await request<{ deployments: { edges: Array<{ node: Deployment }> } }>(
    "query WorkerRailwayDeployments($input:DeploymentListInput!,$first:Int){deployments(input:$input,first:$first){edges{node{id status createdAt}}}}",
    { input: { projectId, serviceId }, first: rawLimit },
  );
  const deployments = deploymentsResult.deployments?.edges?.map(edge => edge.node) ?? [];
  if (action === "deployments") return bounded({ action, projectId, serviceId, deployments, access: "read-only" });

  const deploymentId = requiredId(input.deploymentId, "deploymentId");
  if (!deployments.some(deployment => deployment.id === deploymentId)) throw new Error("Deployment is not in the selected service's recent deployment list");
  const logsResult = await request<{ deploymentLogs: Array<{ timestamp: string; message: string; severity: string }> }>(
    "query WorkerRailwayDeploymentLogs($deploymentId:String!,$limit:Int){deploymentLogs(deploymentId:$deploymentId,limit:$limit){timestamp message severity}}",
    { deploymentId, limit: Math.min(rawLimit, 100) },
  );
  return bounded({ action, projectId, serviceId, deploymentId, logs: logsResult.deploymentLogs ?? [], access: "read-only" });
}
