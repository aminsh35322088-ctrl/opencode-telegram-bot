import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ControlStore, type SqlDatabase } from "../src/cloudflare/control-store.js";
import { RailwayFleetDriver } from "../src/cloudflare/railway-fleet-driver.js";
function fixture() {
  const db = new DatabaseSync(":memory:");
  const sql: SqlDatabase = { exec: (q, ...b) => db.prepare(q).all(...b) as never };
  const store = new ControlStore(sql, (fn) => {
    db.exec("BEGIN");
    try {
      const v = fn();
      db.exec("COMMIT");
      return v;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  });
  store.putBackend({
    backendId: "a",
    workspaceId: "workspace",
    credential: "encrypted",
    desiredMaximumWorkers: 10,
    maxWorkersPerProject: 5,
    region: "europe-west4",
    enabled: true,
  });
  const projects: Array<{
    id: string;
    name: string;
    environments: { edges: Array<{ node: { id: string; name: string } }> };
  }> = [];
  const services: Array<{ id: string; name: string }> = [];
  const volumes: Array<{
    id: string;
    volumeInstances: {
      edges: Array<{
        node: { serviceId: string; volumeId: string; mountPath: string; sizeMB: number };
      }>;
    };
  }> = [];
  let loseProject = false,
    loseVolume = false,
    quota = false;
  let rejectMutation = "";
  const mutations: string[] = [];
  const request = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
    if (rejectMutation && query.includes(rejectMutation))
      return {
        serviceInstanceLimitsUpdate: false,
        variableCollectionUpsert: false,
        environmentPatchCommit: false,
      } as T;
    const input = variables.input as Record<string, unknown>;
    let result: unknown;
    if (query.includes("FleetProjects"))
      result = {
        workspace: {
          projects: { edges: projects.map((node) => ({ node })), pageInfo: { hasNextPage: false } },
        },
      };
    else if (query.includes("FleetProjectCreate")) {
      if (quota) throw new Error("railway_quota_exhausted");
      const p = {
        id: "p" + projects.length,
        name: input.name as string,
        environments: { edges: [{ node: { id: "e" + projects.length, name: "production" } }] },
      };
      projects.push(p);
      if (loseProject) {
        loseProject = false;
        throw new Error("transport_error");
      }
      result = { projectCreate: p };
    } else if (query.includes("FleetInventory"))
      result = {
        project: {
          services: { edges: services.map((node) => ({ node })), pageInfo: { hasNextPage: false } },
          volumes: { edges: volumes.map((node) => ({ node })), pageInfo: { hasNextPage: false } },
        },
        environment: {
          serviceInstances: {
            edges: services.map((s) => ({
              node: {
                serviceId: s.id,
                domains: { serviceDomains: [{ domain: s.id + ".up.railway.app" }] },
                latestDeployment: null,
              },
            })),
            pageInfo: { hasNextPage: false },
          },
        },
      };
    else if (query.includes("FleetDestroyService")) {
      const i = services.findIndex((s) => s.id === variables.id);
      if (i >= 0) services.splice(i, 1);
      result = { serviceDelete: true };
    } else if (query.includes("FleetDestroyVolume")) {
      const i = volumes.findIndex((v) => v.id === variables.volumeId);
      if (i >= 0) volumes.splice(i, 1);
      result = { volumeDelete: true };
    } else if (query.includes("FleetServiceCreate")) {
      const s = { id: "s" + services.length, name: input.name as string };
      services.push(s);
      result = { serviceCreate: s };
    } else if (query.includes("FleetVolumeCreate")) {
      const v = { id: "v" + volumes.length, volumeInstances: { edges: [] } };
      volumes.push(v);
      if (loseVolume) {
        loseVolume = false;
        throw new Error("transport_error");
      }
      result = { volumeCreate: v };
    } else if (query.includes("FleetDomain"))
      result = { serviceDomainCreate: { domain: "s0.up.railway.app" } };
    else {
      const patch = variables.patch as {
        services?: Record<string, { volumeMounts?: Record<string, { mountPath: string }> }>;
      };
      for (const [serviceId, svc] of Object.entries(patch?.services ?? {}))
        for (const volumeId of Object.keys(svc.volumeMounts ?? {})) {
          const volume = volumes.find((v) => v.id === volumeId)!;
          volume.volumeInstances.edges = [
            { node: { serviceId, volumeId, mountPath: "/data", sizeMB: 500 } },
          ];
        }
      mutations.push(JSON.stringify(variables));
      const field = query.includes("FleetLimits")
        ? "serviceInstanceLimitsUpdate"
        : query.includes("FleetConfig")
          ? "serviceInstanceUpdate"
          : query.includes("FleetVariables")
            ? "variableCollectionUpsert"
            : "environmentPatchCommit";
      result = { [field]: field === "environmentPatchCommit" ? "workflow-receipt" : true };
    }
    return result as T;
  };
  const driver = new RailwayFleetDriver(store, request, {
    image: "ghcr.io/example/worker@sha256:" + "a".repeat(64),
    controlUrl: "https://control.example",
    bootstrap: async () => "one-time-token",
  });
  return {
    rejectMutation: (name: string) => {
      rejectMutation = name;
    },
    store,
    driver,
    request,
    projects,
    services,
    volumes,
    mutations,
    loseProject: () => {
      loseProject = true;
    },
    loseVolume: () => {
      loseVolume = true;
    },
    quota: () => {
      quota = true;
    },
  };
}
test("first allocation creates execution project/service/volume and deploys immutable image", async () => {
  const f = fixture();
  const job = f.store.reserveAllocation("first", -100);
  await f.driver.provision(job.jobId);
  assert.equal(f.projects.length, 1);
  assert.equal(f.services.length, 1);
  assert.equal(f.volumes.length, 1);
  assert.equal(f.store.job(job.jobId)!.phase, "DEPLOYING");
  const vars = f.mutations.find((m) => m.includes("BOOTSTRAP_TOKEN"))!;
  assert.ok(vars.includes("CONTROL_PLANE_URL"));
  assert.equal(vars.includes("RAILWAY_API_TOKEN"), false);
  assert.equal(vars.includes("NODE_SHARED_SECRET"), false);
  assert.ok(f.mutations.some((m) => m.includes("@sha256:")));
  assert.equal(
    f.mutations.some((m) => m.includes("commitSha")),
    false,
  );
});
test("lost project create response reconciles deterministic workspace project without duplication", async () => {
  const f = fixture();
  const job = f.store.reserveAllocation("lost", -100);
  f.loseProject();
  await assert.rejects(f.driver.provision(job.jobId), /transport_error/);
  await f.driver.provision(job.jobId);
  assert.equal(f.projects.length, 1);
  assert.equal(f.services.length, 1);
});
test("quota failure is explicit and never activates a Topic or shared/local runtime", async () => {
  const f = fixture();
  f.quota();
  const job = f.store.reserveAllocation("quota", -100);
  await assert.rejects(f.driver.provision(job.jobId), /railway_quota_exhausted/);
  assert.equal(f.store.topics().length, 0);
  assert.equal(f.services.length, 0);
});
test("ambiguous volume response blocks duplicate bare volume creation for operator reconciliation", async () => {
  const f = fixture();
  const job = f.store.reserveAllocation("volume", -100);
  f.loseVolume();
  await assert.rejects(f.driver.provision(job.jobId), /transport_error/);
  await assert.rejects(f.driver.provision(job.jobId), /reconciliation_required/);
  assert.equal(f.volumes.length, 1);
  assert.equal(f.services.length, 1);
});

test("false Railway mutation receipts stop deployment instead of publishing unsafe runtime", async () => {
  for (const operation of ["FleetLimits", "FleetVariables", "FleetDeploy"]) {
    const f = fixture();
    f.rejectMutation(operation);
    const job = f.store.reserveAllocation(operation, -100);
    await assert.rejects(f.driver.provision(job.jobId), /railway_mutation_rejected/);
    assert.notEqual(f.store.job(job.jobId)!.phase, "DEPLOYING");
  }
});

test("desired immutable image survives retry and cannot silently change within a provisioning job", async () => {
  const f = fixture();
  const job = f.store.reserveAllocation("image", -100);
  await f.driver.provision(job.jobId);
  const image = "ghcr.io/example/worker@sha256:" + "a".repeat(64);
  assert.equal((f.store.job(job.jobId) as unknown as { desiredImage: string }).desiredImage, image);
  assert.equal(
    (f.store.worker(job.workerId) as unknown as { desiredImage: string }).desiredImage,
    image,
  );
  const changed = new RailwayFleetDriver(f.store, f.request, {
    image: "ghcr.io/example/worker@sha256:" + "b".repeat(64),
    controlUrl: "https://control.example",
    bootstrap: async () => "unused",
  });
  await assert.rejects(changed.provision(job.jobId), /image_contract_mismatch/);
});

test("destruction retry reconciles physical absence before releasing capacity", async () => {
  const f = fixture(),
    job = f.store.reserveAllocation("destroy", -100);
  await f.driver.provision(job.jobId);
  f.store.ready(job.workerId, job.generation, "key");
  f.store.bindTopic(job.jobId, 42, "session");
  const worker = f.store.fenceTopic(-100, 42);
  f.store.transition(worker.workerId, worker.generation, "DELETING");
  // Simulate a lost successful delete response: physical service and volume already gone.
  f.services.splice(0);
  f.volumes.splice(0);
  await f.driver.destroy(worker.workerId, worker.generation);
  f.store.confirmDestroyed(worker.workerId, worker.generation);
  assert.equal(f.store.worker(worker.workerId)?.state, "REPLACED");
  assert.equal(f.store.topics().length, 0);
});

test("transport diagnostics classify failures without exposing exception credentials", async () => {
  const { railwayApi } = await import("../src/cloudflare/railway-fleet-driver.js");
  const secret = "synthetic-secret-in-exception";
  const api = railwayApi(secret, async () => {
    throw new TypeError("Invalid header character " + secret);
  });
  await assert.rejects(
    api("query{__typename}", {}),
    (error) =>
      error instanceof Error &&
      error.message === "railway_credential_header_invalid" &&
      !error.message.includes(secret),
  );
});

test("Workers-compatible manual redirects never forward the Railway credential", async () => {
  const { railwayApi } = await import("../src/cloudflare/railway-fleet-driver.js");
  let count = 0;
  const api = railwayApi("synthetic", async (_url, init) => {
    count++;
    assert.equal(init?.redirect, "manual");
    return new Response("", { status: 302, headers: { location: "https://other.example" } });
  });
  await assert.rejects(api("query{__typename}", {}), /railway_redirect_rejected/);
  assert.equal(count, 1);
});

test("deployment inspection compares actual Railway source with immutable image contract", async () => {
  const f = fixture(),
    job = f.store.reserveAllocation("observed", -100);
  await f.driver.provision(job.jobId);
  let actual = "ghcr.io/example/worker@sha256:" + "a".repeat(64);
  const request = async <T>(q: string, v: Record<string, unknown>): Promise<T> => {
    const data = await f.request<{
      environment: { serviceInstances: { edges: Array<{ node: Record<string, unknown> }> } };
    }>(q, v);
    for (const edge of data.environment.serviceInstances.edges) {
      edge.node.source = { image: actual };
      edge.node.latestDeployment = { id: "deploy1", status: "SUCCESS" };
    }
    return data as T;
  };
  const driver = new RailwayFleetDriver(f.store, request, {
    image: actual,
    controlUrl: "https://control.example",
    bootstrap: async () => "",
  });
  assert.deepEqual(await driver.inspectDeployment(job.jobId), {
    image: actual,
    deploymentId: "deploy1",
    status: "SUCCESS",
  });
  actual = "ghcr.io/example/worker@sha256:" + "b".repeat(64);
  await assert.rejects(driver.inspectDeployment(job.jobId), /worker_image_mismatch/);
});

test("cleanup discovers a service whose create response was lost", async () => {
  const f = fixture(),
    job = f.store.reserveAllocation("lost-service-cleanup", -100);
  await f.driver.provision(job.jobId);
  const worker = f.store.worker(job.workerId)!;
  const persisted = { ...f.store.worker(job.workerId)!, serviceId: undefined };
  const serialized = JSON.stringify(persisted);
  (f.store as unknown as { sql: SqlDatabase }).sql.exec(
    "UPDATE workers SET data=? WHERE id=?",
    serialized,
    job.workerId,
  );
  f.store.fenceWorker(worker.workerId);
  const fenced = f.store.worker(worker.workerId)!;
  f.store.transition(fenced.workerId, fenced.generation, "DELETING");
  await f.driver.destroy(fenced.workerId, fenced.generation);
  assert.equal(f.services.length, 0);
});

test("an ambiguous unattached volume prevents cleanup confirmation", async () => {
  const f = fixture(),
    job = f.store.reserveAllocation("lost-volume-cleanup", -100);
  f.loseVolume();
  await assert.rejects(f.driver.provision(job.jobId));
  const worker = f.store.fenceWorker(job.workerId);
  f.store.transition(worker.workerId, worker.generation, "DELETING");
  await assert.rejects(
    f.driver.destroy(worker.workerId, worker.generation),
    /cleanup_reconciliation_required/,
  );
});
