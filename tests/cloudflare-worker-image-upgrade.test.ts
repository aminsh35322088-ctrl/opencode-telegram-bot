import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { ControlStore, type SqlDatabase } from "../src/cloudflare/control-store.js";
import {
  WorkerImageUpgrade,
  isWorkerImageUpgrading,
} from "../src/cloudflare/worker-image-upgrade.js";

const target = {
  image: `ghcr.io/example/worker@sha256:${"a".repeat(64)}`,
  commit: "b".repeat(40),
  version: "1.18.33-bot.13-pre.24",
};
function fixture() {
  const db = new Database(":memory:");
  const sql: SqlDatabase = {
    exec: (q, ...b) =>
      (() => {
        const statement = db.prepare(q);
        if (statement.reader) return statement.all(...b);
        statement.run(...b);
        return [];
      })() as never,
  };
  const transaction = <T>(fn: () => T): T => {
    db.exec("BEGIN");
    try {
      const value = fn();
      db.exec("COMMIT");
      return value;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  const store = new ControlStore(sql, transaction);
  const worker = {
    workerId: "node",
    backendId: "backend",
    generation: 2,
    state: "BOUND_IDLE",
    projectId: "project",
    environmentId: "environment",
    serviceId: "service",
    volumeId: "volume",
    endpoint: "https://node.up.railway.app",
    chatId: -100,
    threadId: 42,
    credential: "encrypted",
    revision: 3,
  };
  db.prepare("INSERT INTO workers VALUES(?,?,?)").run("node", "backend", JSON.stringify(worker));
  db.prepare("INSERT INTO topics VALUES(?,?,?,?)").run(
    -100,
    42,
    "node",
    JSON.stringify({
      chatId: -100,
      threadId: 42,
      workerId: "node",
      generation: 2,
      sessionId: "ses_owned",
      state: "ACTIVE",
    }),
  );
  let image = `ghcr.io/example/worker@sha256:${"c".repeat(64)}`,
    deployment = "old",
    status = "SUCCESS",
    ready = true,
    active: unknown = null,
    runtime = {
      telegramCoreCommit: target.commit,
      telegramCoreVersion: target.version,
      runtimeProfile: "telegram-headless",
    };
  let reject = false,
    lost = false,
    foreignVolume = false,
    foreignDomain = false,
    paginated = false,
    admin = true;
  const mutations: Record<string, unknown>[] = [],
    calls: string[] = [];
  const request = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
    calls.push(query);
    if (query.startsWith("mutation")) {
      mutations.push(variables);
      image = target.image;
      deployment = "new";
      if (lost) throw new Error("transport_error");
      return { environmentPatchCommit: reject ? false : "receipt" } as T;
    }
    return {
      project: {
        services: {
          edges: [{ node: { id: "service", name: "topic-node-node" } }],
          pageInfo: { hasNextPage: paginated },
        },
        volumes: {
          edges: [
            {
              node: {
                id: "volume",
                volumeInstances: {
                  edges: [
                    {
                      node: {
                        serviceId: "service",
                        volumeId: foreignVolume ? "foreign" : "volume",
                        mountPath: "/data",
                        sizeMB: 500,
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          ],
          pageInfo: { hasNextPage: false },
        },
      },
      environment: {
        serviceInstances: {
          edges: [
            {
              node: {
                serviceId: "service",
                source: { image },
                domains: {
                  serviceDomains: [
                    { domain: foreignDomain ? "foreign.up.railway.app" : "node.up.railway.app" },
                  ],
                },
                latestDeployment: {
                  id: deployment,
                  status: deployment === "old" ? "SUCCESS" : status,
                },
              },
            },
          ],
          pageInfo: { hasNextPage: false },
        },
      },
    } as T;
  };
  const rpc = async (_workerId: string, op: string, sessionId: string): Promise<unknown> => {
    assert.equal(sessionId, "ses_owned");
    calls.push(op);
    if (op === "status") return active;
    if (op === "session.get") return { id: "ses_owned" };
    return { ready, runtime };
  };
  const service = () =>
    new WorkerImageUpgrade({
      store,
      sql,
      transaction,
      request,
      rpc,
      assertAdmin: () => {
        if (!admin) throw new Error("admin_required");
      },
    });
  return {
    db,
    sql,
    store,
    service,
    mutations,
    calls,
    set: (value: {
      active?: unknown;
      ready?: boolean;
      status?: string;
      reject?: boolean;
      lost?: boolean;
      foreignVolume?: boolean;
      foreignDomain?: boolean;
      paginated?: boolean;
      admin?: boolean;
      runtime?: typeof runtime;
      image?: string;
      deployment?: string;
    }) => {
      if ("active" in value) active = value.active;
      if (value.ready !== undefined) ready = value.ready;
      if (value.status) status = value.status;
      if (value.reject !== undefined) reject = value.reject;
      if (value.lost !== undefined) lost = value.lost;
      if (value.foreignVolume !== undefined) foreignVolume = value.foreignVolume;
      if (value.foreignDomain !== undefined) foreignDomain = value.foreignDomain;
      if (value.paginated !== undefined) paginated = value.paginated;
      if (value.admin !== undefined) admin = value.admin;
      if (value.runtime) runtime = value.runtime;
      if (value.image) image = value.image;
      if (value.deployment) deployment = value.deployment;
    },
  };
}
test("immutable image upgrade changes only owned service source and preserves Topic identity", async () => {
  const f = fixture();
  const result = await f.service().advance("node", 2, target);
  assert.equal(result.phase, "COMPLETE");
  assert.equal(f.mutations.length, 1);
  assert.deepEqual(f.mutations[0], {
    environmentId: "environment",
    patch: { services: { service: { source: { image: target.image } } } },
  });
  assert.equal(f.store.worker("node")!.generation, 2);
  assert.equal(f.store.worker("node")!.volumeId, "volume");
  assert.equal(f.store.worker("node")!.state, "BOUND_IDLE");
  assert.equal(f.store.topics()[0]!.sessionId, "ses_owned");
  assert.equal(f.store.worker("node")!.runtimeVersion, target.version);
  assert.equal(isWorkerImageUpgrading(f.sql, "node"), false);
});
test("active signed execution blocks upgrade before any Railway mutation", async () => {
  const f = fixture();
  f.set({ active: { runId: "native-run" } });
  await assert.rejects(f.service().advance("node", 2, target), /worker_not_idle/);
  assert.equal(f.mutations.length, 0);
  assert.equal(isWorkerImageUpgrading(f.sql, "node"), true);
});
test("active or queued durable prompts block upgrade before creating a fence", async () => {
  const f = fixture();
  f.db
    .prepare("INSERT INTO runs(request,chat,thread,prompt,state) VALUES(?,?,?,?,?)")
    .run("queued", -100, 42, "private prompt", "QUEUED");
  await assert.rejects(f.service().advance("node", 2, target), /worker_not_idle/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.worker("node")!.state, "BOUND_IDLE");
});
test("admin authorization and exact generation are required before I/O", async () => {
  const f = fixture();
  f.set({ admin: false });
  await assert.rejects(f.service().advance("node", 2, target), /admin_required/);
  f.set({ admin: true });
  await assert.rejects(f.service().advance("node", 3, target), /stale_generation/);
  assert.equal(f.calls.length, 0);
});
test("mutable image references and invalid release identities are rejected before I/O", async () => {
  const f = fixture();
  for (const value of [
    { ...target, image: "ghcr.io/example/worker:latest" },
    { ...target, commit: "moving-main" },
    { ...target, version: "latest" },
  ])
    await assert.rejects(f.service().advance("node", 2, value), /invalid_upgrade_target/);
  assert.equal(f.calls.length, 0);
});
test("foreign volume, endpoint and incomplete inventory fail before mutation", async () => {
  for (const value of [{ foreignVolume: true }, { foreignDomain: true }, { paginated: true }]) {
    const f = fixture();
    f.set(value);
    await assert.rejects(f.service().advance("node", 2, target));
    assert.equal(f.mutations.length, 0);
  }
});
test("lost submission reply reconciles once without submitting a second deployment", async () => {
  const f = fixture();
  f.set({ lost: true });
  await assert.rejects(f.service().advance("node", 2, target), /transport_error/);
  assert.equal(f.mutations.length, 1);
  f.set({ lost: false });
  assert.equal((await f.service().advance("node", 2, target)).phase, "COMPLETE");
  assert.equal(f.mutations.length, 1);
});
test("ambiguous submission with unchanged deployment remains fenced without retry mutation", async () => {
  const f = fixture();
  f.set({ lost: true });
  await assert.rejects(f.service().advance("node", 2, target));
  f.set({
    lost: false,
    image: `ghcr.io/example/worker@sha256:${"c".repeat(64)}`,
    deployment: "old",
  });
  assert.equal((await f.service().advance("node", 2, target)).phase, "SUBMITTED");
  assert.equal(f.mutations.length, 1);
  assert.equal(isWorkerImageUpgrading(f.sql, "node"), true);
});
test("deployment success plus signed exact runtime readiness are both required", async () => {
  const f = fixture();
  f.set({ status: "DEPLOYING" });
  assert.equal((await f.service().advance("node", 2, target)).phase, "SUBMITTED");
  f.set({
    status: "SUCCESS",
    runtime: {
      telegramCoreCommit: target.commit,
      telegramCoreVersion: "1.18.33-bot.13-pre.23",
      runtimeProfile: "telegram-headless",
    },
  });
  assert.equal((await f.service().advance("node", 2, target)).phase, "SUBMITTED");
  f.set({
    runtime: {
      telegramCoreCommit: target.commit,
      telegramCoreVersion: target.version,
      runtimeProfile: "telegram-headless",
    },
  });
  assert.equal((await f.service().advance("node", 2, target)).phase, "COMPLETE");
});
test("failed deployment and false mutation receipts cannot reopen Worker admission", async () => {
  for (const value of [{ status: "FAILED" }, { reject: true }]) {
    const f = fixture();
    f.set(value);
    await assert.rejects(f.service().advance("node", 2, target));
    assert.equal(isWorkerImageUpgrading(f.sql, "node"), true);
    assert.equal(f.store.worker("node")!.state, "RECOVERING");
  }
});
