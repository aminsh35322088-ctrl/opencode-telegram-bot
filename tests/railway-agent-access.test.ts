import test from "node:test";
import assert from "node:assert/strict";
import { runRailwayAgentAccess } from "../src/infrastructure/railway-agent-access.js";

const project = {
  id: "project-1",
  name: "project",
  description: null,
  services: { edges: [{ node: { id: "service-1", name: "api" } }] },
  environments: { edges: [{ node: { id: "environment-1", name: "production" } }] },
};

function requestFixture() {
  const calls: Array<{ document: string; variables: Record<string, unknown> }> = [];
  const request = async <T>(document: string, variables: Record<string, unknown> = {}): Promise<T> => {
    calls.push({ document, variables });
    if (document.includes("WorkerRailwayProjects")) return { projects: { edges: [{ node: { id: "project-1", name: "project", description: null } }] } } as T;
    if (document.includes("WorkerRailwayWorkspace")) return { workspace: { id: "workspace-1", name: "workspace" } } as T;
    if (document.includes("WorkerRailwayProject")) return { project } as T;
    if (document.includes("WorkerRailwayServiceInstance")) return { serviceInstance: { serviceName: "api", latestDeployment: { id: "deployment-1", status: "SUCCESS", createdAt: "2026-10-20T00:00:00Z" } } } as T;
    if (document.includes("WorkerRailwayDeployments")) return { deployments: { edges: [{ node: { id: "deployment-1", status: "SUCCESS", createdAt: "2026-10-20T00:00:00Z" } }] } } as T;
    if (document.includes("WorkerRailwayDeploymentLogs")) return { deploymentLogs: [{ timestamp: "2026-10-20T00:00:00Z", severity: "info", message: "token=supersecret" }] } as T;
    throw new Error("unexpected GraphQL document");
  };
  return { request, calls };
}

test("Railway agent access is read-only and lists only the configured workspace", async () => {
  const { request, calls } = requestFixture();
  const result = await runRailwayAgentAccess(request, "workspace-1", { action: "projects" }) as { projects: unknown[]; access: string };
  assert.equal(result.access, "read-only");
  assert.equal(result.projects.length, 1);
  assert.deepEqual(calls[0]?.variables, { workspaceId: "workspace-1" });
});

test("Railway agent access rejects projects outside the configured workspace", async () => {
  const { request } = requestFixture();
  await assert.rejects(() => runRailwayAgentAccess(request, "workspace-1", { action: "project", projectId: "project-foreign" }), /outside the configured workspace/);
});

test("Railway service instance requires service and environment ownership in the selected project", async () => {
  const { request } = requestFixture();
  await assert.rejects(() => runRailwayAgentAccess(request, "workspace-1", {
    action: "service-instance", projectId: "project-1", serviceId: "service-foreign", environmentId: "environment-1",
  }), /outside the selected project/);
});

test("Railway logs are deployment-scoped and redact token-like values", async () => {
  const { request } = requestFixture();
  const result = await runRailwayAgentAccess(request, "workspace-1", {
    action: "logs", projectId: "project-1", serviceId: "service-1", deploymentId: "deployment-1", limit: 10,
  }) as { logs: Array<{ message: string }> };
  assert.equal(result.logs[0]?.message, "token=[REDACTED]");
});

test("Railway agent access rejects arbitrary GraphQL and mutation actions", async () => {
  const { request, calls } = requestFixture();
  await assert.rejects(() => runRailwayAgentAccess(request, "workspace-1", { action: "mutation", query: "mutation { projectDelete(id: \"project-1\") }" }), /Unexpected Railway tool argument|Unsupported Railway action/);
  assert.equal(calls.length, 0);
});
