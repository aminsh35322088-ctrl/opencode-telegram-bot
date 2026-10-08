import type { ControlStore, FleetTopic, FleetWorker, SqlDatabase } from "./control-store.js";

export interface WorkerImageTarget {
  image: string;
  commit: string;
  version: string;
}
export interface WorkerImageUpgradeRecord {
  workerId: string;
  generation: number;
  projectId: string;
  environmentId: string;
  serviceId: string;
  volumeId: string;
  endpoint: string;
  sessionId: string;
  target: WorkerImageTarget;
  phase: "CHECKING" | "SUBMITTED" | "COMPLETE";
  previousDeploymentId?: string;
  deploymentReceipt?: string;
  deploymentId?: string;
}
type RequestApi = <T>(query: string, variables: Record<string, unknown>) => Promise<T>;
type Connection<T> = { edges: Array<{ node: T }>; pageInfo?: { hasNextPage: boolean } };
interface Inventory {
  project: {
    services: Connection<{ id: string; name: string; deletedAt?: string | null }>;
    volumes: Connection<{
      id: string;
      volumeInstances: Connection<{
        serviceId: string | null;
        volumeId: string;
        mountPath: string;
        sizeMB: number;
        deletedAt?: string | null;
        isPendingDeletion?: boolean;
      }>;
    }>;
  };
  environment: {
    serviceInstances: Connection<{
      serviceId: string;
      source?: { image?: string };
      domains: { serviceDomains: Array<{ domain: string }> };
      latestDeployment?: { id: string; status?: string } | null;
    }>;
  };
}
// Same inventory and EnvironmentConfig mutation contract as RailwayFleetDriver.
const inventoryQuery =
  "query WorkerUpgradeInventory($projectId:String!,$environmentId:String!){project(id:$projectId){services(first:100){edges{node{id name deletedAt}} pageInfo{hasNextPage}} volumes(first:100){edges{node{id volumeInstances(first:100){edges{node{serviceId volumeId mountPath sizeMB deletedAt isPendingDeletion}} pageInfo{hasNextPage}}}} pageInfo{hasNextPage}}} environment(id:$environmentId){serviceInstances(first:100){edges{node{serviceId source{image} domains{serviceDomains{domain}} latestDeployment{id status}}} pageInfo{hasNextPage}}}}";
const key = (id: string) => "worker-image-upgrade:" + id;
function read(sql: SqlDatabase, workerId: string): WorkerImageUpgradeRecord | undefined {
  const row = [
    ...sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key=?", key(workerId)),
  ][0];
  return row ? (JSON.parse(row.data) as WorkerImageUpgradeRecord) : undefined;
}
/** Every execution/mutating-RPC admission path must consult this durable gate. */
export function isWorkerImageUpgrading(sql: SqlDatabase, workerId: string): boolean {
  const record = read(sql, workerId);
  return !!record && record.phase !== "COMPLETE";
}
interface Dependencies {
  store: ControlStore;
  sql: SqlDatabase;
  transaction<T>(fn: () => T): T;
  request: RequestApi;
  /** Must use nodeRpc with the current encrypted identity; never unauthenticated /health. */
  rpc(workerId: string, operation: string, sessionId: string): Promise<unknown>;
  /** Must reject requests not admitted by the privileged admin route. */
  assertAdmin(): void;
  now?(): number;
}
/** One durable, fail-closed image-only upgrade on the existing service and volume.
 * Call advance from an admin request/alarm until COMPLETE. Transport uncertainty
 * after submission is reconciled by observation, never a second mutation.
 */
export class WorkerImageUpgrade {
  constructor(private readonly deps: Dependencies) {}
  private save(record: WorkerImageUpgradeRecord): void {
    this.deps.sql.exec(
      "INSERT INTO ui_state(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
      key(record.workerId),
      JSON.stringify(record),
    );
  }
  private owned(record: WorkerImageUpgradeRecord): { worker: FleetWorker; topic: FleetTopic } {
    const worker = this.deps.store.worker(record.workerId);
    const topics = this.deps.store.topics().filter((t) => t.workerId === record.workerId);
    const topic = topics[0];
    if (
      !worker ||
      worker.generation !== record.generation ||
      topics.length !== 1 ||
      !topic ||
      topic.generation !== record.generation ||
      topic.sessionId !== record.sessionId ||
      topic.state !== "ACTIVE" ||
      worker.chatId !== topic.chatId ||
      worker.threadId !== topic.threadId ||
      worker.projectId !== record.projectId ||
      worker.environmentId !== record.environmentId ||
      worker.serviceId !== record.serviceId ||
      worker.volumeId !== record.volumeId ||
      worker.endpoint !== record.endpoint
    )
      throw new Error("stale_generation");
    return { worker, topic };
  }
  private assertNoRuns(topic: FleetTopic): void {
    if (
      [
        ...this.deps.sql.exec(
          "SELECT request FROM runs WHERE chat=? AND thread=? AND state IN ('QUEUED','ACTIVE') LIMIT 1",
          topic.chatId,
          topic.threadId,
        ),
      ].length
    )
      throw new Error("worker_not_idle");
  }
  private async inventory(record: WorkerImageUpgradeRecord, guard: () => void) {
    guard();
    const value = await this.deps.request<Inventory>(inventoryQuery, {
      projectId: record.projectId,
      environmentId: record.environmentId,
    });
    guard();
    if (
      value.project.services.pageInfo?.hasNextPage ||
      value.project.volumes.pageInfo?.hasNextPage ||
      value.environment.serviceInstances.pageInfo?.hasNextPage ||
      value.project.volumes.edges.some((v) => v.node.volumeInstances.pageInfo?.hasNextPage)
    )
      throw new Error("inventory_pagination_required");
    const services = value.project.services.edges.filter(
      (s) => s.node.id === record.serviceId && !s.node.deletedAt,
    );
    const instances = value.environment.serviceInstances.edges.filter(
      (s) => s.node.serviceId === record.serviceId,
    );
    const mounts = value.project.volumes.edges
      .flatMap((v) => v.node.volumeInstances.edges.map((i) => ({ volume: v.node.id, ...i.node })))
      .filter((i) => i.serviceId === record.serviceId);
    if (
      services.length !== 1 ||
      services[0]!.node.name !== "topic-node-" + record.workerId ||
      instances.length !== 1 ||
      mounts.length !== 1 ||
      mounts[0]!.volume !== record.volumeId ||
      mounts[0]!.volumeId !== record.volumeId ||
      mounts[0]!.mountPath !== "/data" ||
      mounts[0]!.sizeMB !== 500 ||
      mounts[0]!.deletedAt ||
      mounts[0]!.isPendingDeletion
    )
      throw new Error("upgrade_inventory_mismatch");
    const instance = instances[0]!.node;
    if (!instance.domains.serviceDomains.some((d) => "https://" + d.domain === record.endpoint))
      throw new Error("upgrade_endpoint_mismatch");
    return instance;
  }
  async advance(
    workerId: string,
    generation: number,
    target: WorkerImageTarget,
  ): Promise<WorkerImageUpgradeRecord> {
    this.deps.assertAdmin();
    if (
      !/^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/.test(target.image) ||
      !/^[a-f0-9]{40}$/.test(target.commit) ||
      !/^\d+\.\d+\.\d+-bot\.\d+-pre\.\d+$/.test(target.version)
    )
      throw new Error("invalid_upgrade_target");
    let record = read(this.deps.sql, workerId);
    const worker = this.deps.store.worker(workerId);
    if (!worker || worker.generation !== generation) throw new Error("stale_generation");
    if (
      record &&
      record.phase === "COMPLETE" &&
      JSON.stringify(record.target) !== JSON.stringify(target)
    )
      record = undefined;
    if (
      record &&
      (record.generation !== generation ||
        record.target.image !== target.image ||
        record.target.commit !== target.commit ||
        record.target.version !== target.version)
    )
      throw new Error("upgrade_identity_mismatch");
    if (!record) {
      const topics = this.deps.store.topics().filter((t) => t.workerId === workerId);
      const topic = topics[0];
      if (
        !topic ||
        topics.length !== 1 ||
        topic.generation !== generation ||
        topic.state !== "ACTIVE" ||
        !["BOUND_IDLE", "SLEEPING"].includes(worker.state) ||
        !worker.projectId ||
        !worker.environmentId ||
        !worker.serviceId ||
        !worker.volumeId ||
        !worker.endpoint
      )
        throw new Error("worker_not_idle");
      this.assertNoRuns(topic);
      record = {
        workerId,
        generation,
        projectId: worker.projectId,
        environmentId: worker.environmentId,
        serviceId: worker.serviceId,
        volumeId: worker.volumeId,
        endpoint: worker.endpoint,
        sessionId: topic.sessionId,
        target: { ...target },
        phase: "CHECKING",
      };
      this.deps.transaction(() => {
        this.owned(record!);
        this.assertNoRuns(topic);
        this.save(record!);
        this.deps.store.transition(workerId, generation, "FENCING");
        this.deps.store.transition(workerId, generation, "RECOVERING");
      });
    }
    if (record.phase === "COMPLETE") {
      this.owned(record);
      return record;
    }
    const selected = record;
    const owner = crypto.randomUUID(),
      lease = key(workerId),
      now = () => this.deps.now?.() ?? Date.now();
    if (!this.deps.store.acquireLease(lease, owner, now(), 120_000))
      throw new Error("upgrade_in_progress");
    const guard = () => {
      this.deps.assertAdmin();
      this.owned(selected);
      if (this.deps.store.worker(workerId)!.state !== "RECOVERING")
        throw new Error("upgrade_fence_lost");
      this.deps.store.renewLease(lease, owner, now(), 120_000);
    };
    const rpc = async (op: string) => {
      guard();
      const result = await this.deps.rpc(workerId, op, selected.sessionId);
      guard();
      return result;
    };
    try {
      if (selected.phase === "CHECKING") {
        this.assertNoRuns(this.owned(selected).topic);
        if ((await rpc("status")) !== null) throw new Error("worker_not_idle");
        const health = (await rpc("health")) as { ready?: boolean };
        if (health?.ready !== true) throw new Error("worker_not_ready");
        const session = (await rpc("session.get")) as { id?: string };
        if (session?.id !== selected.sessionId) throw new Error("upgrade_session_mismatch");
        const before = await this.inventory(selected, guard);
        if (!before.latestDeployment?.id || before.latestDeployment.status !== "SUCCESS")
          throw new Error("worker_deployment_not_stable");
        guard();
        this.assertNoRuns(this.owned(selected).topic);
        selected.previousDeploymentId = before.latestDeployment.id;
        selected.phase = "SUBMITTED";
        this.save(selected);
        const result = await this.deps.request<{ environmentPatchCommit: unknown }>(
          'mutation WorkerImageUpgrade($environmentId:String!,$patch:EnvironmentConfig!){environmentPatchCommit(environmentId:$environmentId,patch:$patch,commitMessage:"Upgrade immutable execution Worker in place")}',
          {
            environmentId: selected.environmentId,
            patch: { services: { [selected.serviceId]: { source: { image: target.image } } } },
          },
        );
        guard();
        if (
          typeof result.environmentPatchCommit !== "string" ||
          !result.environmentPatchCommit.trim() ||
          result.environmentPatchCommit.length > 256
        )
          throw new Error("railway_mutation_rejected");
        selected.deploymentReceipt = result.environmentPatchCommit;
        this.save(selected);
      }
      const deployed = await this.inventory(selected, guard);
      if (
        deployed.source?.image !== target.image ||
        !deployed.latestDeployment?.id ||
        deployed.latestDeployment.id === selected.previousDeploymentId
      )
        return selected;
      if (["FAILED", "CRASHED", "REMOVED"].includes(deployed.latestDeployment.status ?? ""))
        throw new Error("worker_deployment_failed");
      if (deployed.latestDeployment.status !== "SUCCESS") return selected;
      const health = (await rpc("health")) as {
        ready?: boolean;
        runtime?: {
          telegramCoreCommit?: string;
          telegramCoreVersion?: string;
          runtimeProfile?: string;
        };
      };
      if (
        health?.ready !== true ||
        health.runtime?.telegramCoreCommit !== target.commit ||
        health.runtime.telegramCoreVersion !== target.version ||
        health.runtime.runtimeProfile !== "telegram-headless"
      )
        return selected;
      const session = (await rpc("session.get")) as { id?: string };
      if (session?.id !== selected.sessionId) throw new Error("upgrade_session_mismatch");
      if ((await rpc("status")) !== null) throw new Error("worker_not_idle");
      // Re-read after signed readiness: source/volume/domain drift must not reopen admission.
      const final = await this.inventory(selected, guard);
      if (
        final.source?.image !== target.image ||
        final.latestDeployment?.id !== deployed.latestDeployment.id ||
        final.latestDeployment.status !== "SUCCESS"
      )
        throw new Error("upgrade_inventory_changed");
      this.deps.transaction(() => {
        guard();
        this.assertNoRuns(this.owned(selected).topic);
        this.deps.store.saveObservation(workerId, generation, {
          image: target.image,
          deploymentId: final.latestDeployment!.id,
          runtimeCommit: target.commit,
          runtimeVersion: target.version,
          lastHealthAt: now(),
        });
        this.deps.store.transition(workerId, generation, "BOUND_IDLE");
        selected.phase = "COMPLETE";
        selected.deploymentId = final.latestDeployment!.id;
        this.save(selected);
      });
      return selected;
    } finally {
      this.deps.store.releaseLease(lease, owner);
    }
  }
}
