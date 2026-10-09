import type { SqlStorage } from "@cloudflare/workers-types";
export type SqlDatabase = Pick<SqlStorage, "exec">;
export type WorkerState =
  | "PROVISIONING"
  | "READY_UNBOUND"
  | "BINDING"
  | "BOUND_IDLE"
  | "BOUND_ACTIVE"
  | "SLEEPING"
  | "FENCING"
  | "CLEANING"
  | "UNHEALTHY"
  | "RECOVERING"
  | "REPLACED"
  | "DELETING";
export interface RailwayBackend {
  backendId: string;
  workspaceId: string;
  credential: string;
  region: string;
  desiredMaximumWorkers: number;
  maxWorkersPerProject: number;
  enabled: boolean;
  maxProjects?: number;
  health?: string;
  quotaStatus?: string;
}
export interface FleetProject {
  projectKey: string;
  backendId: string;
  ordinal: number;
  reservedWorkers: number;
  projectId?: string;
  environmentId?: string;
  phase: string;
}
export interface FleetWorker {
  workerId: string;
  backendId: string;
  generation: number;
  state: WorkerState;
  projectKey?: string;
  projectId?: string;
  environmentId?: string;
  serviceId?: string;
  volumeId?: string;
  endpoint?: string;
  desiredImage?: string;
  chatId?: number;
  threadId?: number;
  credential?: string;
  revision: number;
  image?: string;
  deploymentId?: string;
  runtimeCommit?: string;
  runtimeVersion?: string;
  lastHealthAt?: number;
  volumeDeletionPendingUntil?: string;
}
export interface AllocationJob {
  jobId: string;
  requestId: string;
  createdAt?: number;
  chatId: number;
  workerId: string;
  backendId: string;
  generation: number;
  phase: string;
  projectKey?: string;
  projectId?: string;
  environmentId?: string;
  serviceId?: string;
  volumeId?: string;
  endpoint?: string;
  desiredImage?: string;
  threadId?: number;
  error?: string;
  previousDeploymentId?: string;
  deploymentReceipt?: string;
  cleanupPhase?: string;
  topicTitle?: string;
}
export interface FleetTopic {
  chatId: number;
  threadId: number;
  workerId: string;
  generation: number;
  sessionId: string;
  state: string;
}
interface Run {
  requestId: string;
  chatId: number;
  threadId: number;
  prompt: string;
  state: string;
}
const transitions: Record<WorkerState, WorkerState[]> = {
  PROVISIONING: ["READY_UNBOUND", "UNHEALTHY", "DELETING"],
  READY_UNBOUND: ["BINDING", "DELETING", "UNHEALTHY", "SLEEPING"],
  BINDING: ["BOUND_IDLE", "FENCING", "UNHEALTHY"],
  BOUND_IDLE: ["BOUND_ACTIVE", "SLEEPING", "FENCING", "UNHEALTHY"],
  BOUND_ACTIVE: ["BOUND_IDLE", "FENCING", "UNHEALTHY"],
  SLEEPING: ["BINDING", "BOUND_IDLE", "FENCING", "DELETING", "UNHEALTHY"],
  FENCING: ["CLEANING", "RECOVERING", "DELETING"],
  CLEANING: ["READY_UNBOUND", "UNHEALTHY", "DELETING"],
  UNHEALTHY: ["RECOVERING", "FENCING", "DELETING"],
  RECOVERING: ["BOUND_IDLE", "READY_UNBOUND", "REPLACED", "UNHEALTHY"],
  REPLACED: ["DELETING"],
  DELETING: [],
};

/** SQLite is authoritative. Every reservation/fence is synchronous and committed before I/O. */
export class ControlStore {
  constructor(
    private readonly sql: SqlDatabase,
    private readonly transaction: <T>(action: () => T) => T,
  ) {
    this.migrate();
    this.transaction(() => {
      this.sql.exec(
        "CREATE TABLE IF NOT EXISTS run_pins(request TEXT PRIMARY KEY,generation INTEGER NOT NULL,revision INTEGER NOT NULL,model TEXT NOT NULL,dispatched INTEGER NOT NULL DEFAULT 0)",
      );
      this.sql.exec("CREATE TABLE IF NOT EXISTS ui_state(key TEXT PRIMARY KEY,data TEXT NOT NULL)");
      this.sql.exec(
        "CREATE TABLE IF NOT EXISTS ui_callbacks(id TEXT PRIMARY KEY,actor INTEGER NOT NULL,chat INTEGER NOT NULL,thread INTEGER NOT NULL,generation INTEGER NOT NULL,expires INTEGER NOT NULL,data TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'READY')",
      );
      this.sql.exec(
        "CREATE TABLE IF NOT EXISTS ui_delivery(id TEXT PRIMARY KEY,state TEXT NOT NULL,message INTEGER)",
      );
      this.sql.exec(
        "CREATE TABLE IF NOT EXISTS control_secrets(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL)",
      );
      this.sql.exec("UPDATE schema_version SET version=6");
    });
  }
  private migrate(): void {
    this.sql.exec("CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL)");
    const version =
      [...this.sql.exec<{ version: number }>("SELECT version FROM schema_version")][0]?.version ??
      0;
    if (version > 6) throw new Error("unsupported_schema");
    if (version >= 3) return;
    if (version === 2) {
      this.migrateEvents();
      return;
    }
    if (version === 1) {
      this.migrateLeases();
      this.migrateEvents();
      return;
    }
    this.transaction(() => {
      this.sql.exec("CREATE TABLE backends(id TEXT PRIMARY KEY,data TEXT NOT NULL)");
      this.sql.exec(
        "CREATE TABLE projects(id TEXT PRIMARY KEY,backend TEXT NOT NULL,data TEXT NOT NULL)",
      );
      this.sql.exec(
        "CREATE TABLE workers(id TEXT PRIMARY KEY,backend TEXT NOT NULL,data TEXT NOT NULL)",
      );
      this.sql.exec(
        "CREATE TABLE jobs(id TEXT PRIMARY KEY,request TEXT NOT NULL,chat INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(request,chat))",
      );
      this.sql.exec(
        "CREATE TABLE topics(chat INTEGER NOT NULL,thread INTEGER NOT NULL,worker TEXT NOT NULL UNIQUE,data TEXT NOT NULL,PRIMARY KEY(chat,thread))",
      );
      this.sql.exec(
        "CREATE TABLE bootstrap(hash TEXT PRIMARY KEY,job TEXT NOT NULL,expires INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0)",
      );
      this.sql.exec(
        "CREATE TABLE nonces(worker TEXT NOT NULL,generation INTEGER NOT NULL,nonce TEXT NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(worker,generation,nonce))",
      );
      this.sql.exec(
        "CREATE TABLE global_state(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,hash TEXT NOT NULL,data TEXT NOT NULL)",
      );
      this.sql.exec(
        "CREATE TABLE runs(seq INTEGER PRIMARY KEY AUTOINCREMENT,request TEXT NOT NULL UNIQUE,chat INTEGER NOT NULL,thread INTEGER NOT NULL,prompt TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'QUEUED')",
      );
      this.sql.exec(
        "CREATE TABLE updates(id INTEGER PRIMARY KEY,data TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'PENDING')",
      );
      this.sql.exec(
        "CREATE TABLE outbox(id TEXT PRIMARY KEY,data TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'PENDING')",
      );
      this.sql.exec(
        "CREATE TABLE approvals(id TEXT PRIMARY KEY,worker TEXT NOT NULL,generation INTEGER NOT NULL,data TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'PENDING')",
      );
      this.sql.exec("INSERT INTO schema_version VALUES(1)");
    });
    this.migrateLeases();
    this.migrateEvents();
  }
  private migrateLeases(): void {
    this.transaction(() => {
      this.sql.exec(
        "CREATE TABLE leases(id TEXT PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL)",
      );
      this.sql.exec("UPDATE schema_version SET version=2");
    });
  }
  private migrateEvents(): void {
    this.transaction(() => {
      this.sql.exec(
        "CREATE TABLE callbacks(run TEXT NOT NULL,stream TEXT NOT NULL,sequence INTEGER NOT NULL,PRIMARY KEY(run,stream,sequence))",
      );
      this.sql.exec(
        "CREATE TABLE response_parts(run TEXT NOT NULL,part TEXT NOT NULL,text TEXT NOT NULL,message TEXT,PRIMARY KEY(run,part))",
      );
      this.sql.exec(
        "CREATE TABLE responses(run TEXT PRIMARY KEY,chat INTEGER NOT NULL,thread INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'PENDING')",
      );
      this.sql.exec(
        "CREATE TABLE message_roles(run TEXT NOT NULL,message TEXT NOT NULL,role TEXT NOT NULL,PRIMARY KEY(run,message))",
      );
      this.sql.exec("UPDATE schema_version SET version=3");
    });
  }
  activeRuns(chatId: number, threadId: number): Run[] {
    return [
      ...this.sql.exec<{
        requestId: string;
        chatId: number;
        threadId: number;
        prompt: string;
        state: string;
      }>(
        "SELECT request AS requestId,chat AS chatId,thread AS threadId,prompt,state FROM runs WHERE chat=? AND thread=? AND state='ACTIVE' ORDER BY seq",
        chatId,
        threadId,
      ),
    ];
  }
  recordCallback(chatId: number, threadId: number, payload: Record<string, unknown>): boolean {
    const runId = String(payload.runId ?? ""),
      stream = String(payload.streamNonce ?? ""),
      sequence = Number(payload.sequence);
    if (!runId || !stream || !Number.isSafeInteger(sequence) || sequence < 1)
      throw new Error("invalid_event");
    return this.transaction(() => {
      if (
        [
          ...this.sql.exec(
            "SELECT run FROM callbacks WHERE run=? AND stream=? AND sequence=?",
            runId,
            stream,
            sequence,
          ),
        ].length
      )
        return false;
      if (!this.activeRuns(chatId, threadId).some((r) => r.requestId === runId))
        throw new Error("run_mismatch");
      this.sql.exec("INSERT INTO callbacks VALUES(?,?,?)", runId, stream, sequence);
      const event = payload.event as {
        type?: string;
        properties?: {
          part?: { id?: string; type?: string; text?: string; messageID?: string };
          info?: { id?: string; role?: string };
          status?: { type?: string };
          partID?: string;
          messageID?: string;
          field?: string;
          delta?: string;
        };
      };
      const info = event?.properties?.info;
      if (event?.type === "message.updated" && info?.id && info.role)
        this.sql.exec(
          "INSERT INTO message_roles VALUES(?,?,?) ON CONFLICT(run,message) DO UPDATE SET role=excluded.role",
          runId,
          info.id,
          info.role,
        );
      const part = event?.properties?.part;
      if (
        event?.type === "message.part.updated" &&
        part?.type === "text" &&
        typeof part.text === "string" &&
        part.id
      ) {
        if (part.text.length > 262144) throw new Error("response_too_large");
        this.sql.exec(
          "INSERT INTO response_parts VALUES(?,?,?,?) ON CONFLICT(run,part) DO UPDATE SET text=excluded.text",
          runId,
          part.id,
          part.text,
          part.messageID ?? null,
        );
      }
      const delta = event?.properties;
      if (
        event?.type === "message.part.delta" &&
        delta?.field === "text" &&
        typeof delta.delta === "string" &&
        delta.partID
      ) {
        const row = [
          ...this.sql.exec<{ text: string; message: string }>(
            "SELECT text,message FROM response_parts WHERE run=? AND part=?",
            runId,
            delta.partID,
          ),
        ][0];
        if (row && row.message === delta.messageID) {
          if (row.text.length + delta.delta.length > 262144) throw new Error("response_too_large");
          this.sql.exec(
            "UPDATE response_parts SET text=? WHERE run=? AND part=?",
            row.text + delta.delta,
            runId,
            delta.partID,
          );
        }
      }
      if (
        event?.type === "session.idle" ||
        event?.type === "session.error" ||
        (event?.type === "session.status" && event.properties?.status?.type === "idle")
      ) {
        this.sql.exec(
          "INSERT INTO responses(run,chat,thread) VALUES(?,?,?)",
          runId,
          chatId,
          threadId,
        );
        this.finishRun(chatId, threadId, runId);
      }
      return true;
    });
  }
  failRun(chatId: number, threadId: number, requestId: string, text: string): void {
    this.transaction(() => {
      if (!this.activeRuns(chatId, threadId).some((r) => r.requestId === requestId)) return;
      this.sql.exec(
        "INSERT INTO response_parts(run,part,text) VALUES(?,?,?) ON CONFLICT(run,part) DO NOTHING",
        requestId,
        "control_error",
        text,
      );
      this.sql.exec(
        "INSERT INTO responses(run,chat,thread) VALUES(?,?,?) ON CONFLICT(run) DO NOTHING",
        requestId,
        chatId,
        threadId,
      );
      this.sql.exec("UPDATE runs SET state='FAILED' WHERE request=? AND state='ACTIVE'", requestId);
    });
  }
  completedResponses(): Array<{ run: string; chat: number; thread: number; text: string }> {
    return [
      ...this.sql.exec<{ run: string; chat: number; thread: number }>(
        "SELECT run,chat,thread FROM responses WHERE state='PENDING' ORDER BY rowid LIMIT 20",
      ),
    ].map((row) => ({
      ...row,
      text: [
        ...this.sql.exec<{ text: string }>(
          "SELECT p.text FROM response_parts p LEFT JOIN message_roles r ON r.run=p.run AND r.message=p.message WHERE p.run=? AND (p.message IS NULL OR r.role='assistant') ORDER BY p.rowid",
          row.run,
        ),
      ]
        .map((p) => p.text)
        .join("\n\n"),
    }));
  }
  responseDelivered(run: string, state = "DELIVERED"): void {
    this.sql.exec("UPDATE responses SET state=? WHERE run=?", state, run);
  }
  acquireLease(id: string, owner: string, now: number, lifetime: number): boolean {
    return this.transaction(() => {
      const lease = [
        ...this.sql.exec<{ owner: string; expires: number }>(
          "SELECT owner,expires FROM leases WHERE id=?",
          id,
        ),
      ][0];
      if (lease && lease.owner !== owner && lease.expires > now) return false;
      this.sql.exec(
        "INSERT INTO leases VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires",
        id,
        owner,
        now + lifetime,
      );
      return true;
    });
  }
  renewLease(id: string, owner: string, now: number, lifetime: number): void {
    const lease = [
      ...this.sql.exec<{ owner: string; expires: number }>(
        "SELECT owner,expires FROM leases WHERE id=?",
        id,
      ),
    ][0];
    if (!lease || lease.owner !== owner || lease.expires <= now) throw new Error("lease_lost");
    this.sql.exec("UPDATE leases SET expires=? WHERE id=? AND owner=?", now + lifetime, id, owner);
  }
  releaseLease(id: string, owner: string): void {
    this.sql.exec("DELETE FROM leases WHERE id=? AND owner=?", id, owner);
  }
  private all<T>(table: string): T[] {
    return [...this.sql.exec<{ data: string }>(`SELECT data FROM ${table} ORDER BY rowid`)].map(
      (r) => JSON.parse(r.data) as T,
    );
  }
  private one<T>(table: string, id: string): T | undefined {
    const row = [...this.sql.exec<{ data: string }>(`SELECT data FROM ${table} WHERE id=?`, id)][0];
    return row ? (JSON.parse(row.data) as T) : undefined;
  }
  backends(): RailwayBackend[] {
    return this.all("backends");
  }
  projects(): FleetProject[] {
    return this.all("projects");
  }
  workers(): FleetWorker[] {
    return this.all("workers");
  }
  topics(): FleetTopic[] {
    return this.all("topics");
  }
  job(id: string): AllocationJob | undefined {
    return this.one("jobs", id);
  }
  worker(id: string): FleetWorker | undefined {
    return this.one("workers", id);
  }
  putBackend(backend: RailwayBackend): void {
    if (
      !/^[a-zA-Z0-9_-]{1,48}$/.test(backend.backendId) ||
      !backend.workspaceId ||
      !backend.credential ||
      !Number.isSafeInteger(backend.desiredMaximumWorkers) ||
      backend.desiredMaximumWorkers < 0 ||
      !Number.isSafeInteger(backend.maxWorkersPerProject) ||
      backend.maxWorkersPerProject < 1
    )
      throw new Error("invalid_backend_policy");
    this.sql.exec(
      "INSERT INTO backends VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      backend.backendId,
      JSON.stringify(backend),
    );
  }
  private saveWorker(worker: FleetWorker): void {
    this.sql.exec(
      "INSERT INTO workers VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      worker.workerId,
      worker.backendId,
      JSON.stringify(worker),
    );
  }
  private saveJob(job: AllocationJob): void {
    this.sql.exec(
      "INSERT INTO jobs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      job.jobId,
      job.requestId,
      job.chatId,
      JSON.stringify(job),
    );
  }
  reserveTopicAllocation(requestId: string, chatId: number, threadId: number): AllocationJob {
    return this.reserveAllocation(requestId, chatId, threadId);
  }
  reserveAllocation(requestId: string, chatId: number, threadId?: number): AllocationJob {
    return this.transaction(() => {
      if (!requestId || requestId.length > 128 || !Number.isSafeInteger(chatId) || chatId === 0)
        throw new Error("invalid_request");
      if (threadId !== undefined) {
        if (!Number.isSafeInteger(threadId) || threadId <= 1) throw new Error("invalid_topic");
        const owned = this.all<AllocationJob>("jobs").find(
          (j) =>
            j.chatId === chatId &&
            j.threadId === threadId &&
            !["FAILED", "DELETED"].includes(j.phase),
        );
        if (owned) return owned;
      }
      const previous = [
        ...this.sql.exec<{ data: string }>(
          "SELECT data FROM jobs WHERE request=? AND chat=?",
          requestId,
          chatId,
        ),
      ][0];
      if (previous) return JSON.parse(previous.data);
      const backends = this.backends().filter(
        (b) => b.enabled && b.health !== "UNHEALTHY" && b.quotaStatus !== "EXHAUSTED",
      );
      const workers = this.workers();
      let worker = workers.find(
        (w) =>
          backends.some((b) => b.backendId === w.backendId) &&
          (w.chatId === undefined || w.chatId === 0) &&
          (w.state === "READY_UNBOUND" ||
            (w.state === "SLEEPING" && !this.topics().some((t) => t.workerId === w.workerId))),
      );
      if (worker) {
        worker = { ...worker, generation: worker.generation + 1, state: "BINDING" };
      } else {
        const selected = backends.find(
          (b) =>
            workers.filter((w) => w.backendId === b.backendId && w.state !== "REPLACED").length <
            b.desiredMaximumWorkers,
        );
        if (!selected) throw new Error("capacity_exhausted");
        worker = {
          workerId: crypto.randomUUID(),
          backendId: selected.backendId,
          generation: 1,
          state: "PROVISIONING",
          revision: 0,
        };
      }
      if (threadId !== undefined) {
        worker.chatId = chatId;
        worker.threadId = threadId;
      }
      this.saveWorker(worker);
      const job: AllocationJob = {
        jobId: crypto.randomUUID(),
        createdAt: Date.now(),
        ...(threadId !== undefined ? { threadId } : {}),
        requestId,
        chatId,
        workerId: worker.workerId,
        backendId: worker.backendId,
        generation: worker.generation,
        phase: worker.state,
        ...(worker.projectKey
          ? {
              projectKey: worker.projectKey,
              projectId: worker.projectId,
              environmentId: worker.environmentId,
              serviceId: worker.serviceId,
              volumeId: worker.volumeId,
              endpoint: worker.endpoint,
            }
          : {}),
      };
      this.saveJob(job);
      return job;
    });
  }
  selectProject(jobId: string): FleetProject {
    return this.transaction(() => {
      const job = this.job(jobId);
      if (!job) throw new Error("unknown_job");
      const projects = this.projects();
      if (job.projectKey) {
        const project = projects.find((p) => p.projectKey === job.projectKey);
        if (!project) throw new Error("project_missing");
        return project;
      }
      const backend = this.backends().find((b) => b.backendId === job.backendId);
      if (!backend?.enabled) throw new Error("backend_unavailable");
      let project = projects.find(
        (p) =>
          p.backendId === job.backendId &&
          p.phase !== "UNAVAILABLE" &&
          p.reservedWorkers < backend.maxWorkersPerProject,
      );
      if (!project) {
        if (
          backend.maxProjects !== undefined &&
          projects.filter((p) => p.backendId === backend.backendId).length >= backend.maxProjects
        )
          throw new Error("project_capacity_exhausted");
        const ordinal =
          1 +
          Math.max(
            0,
            ...projects.filter((p) => p.backendId === job.backendId).map((p) => p.ordinal),
          );
        project = {
          projectKey: `workers-${job.backendId}-${String(ordinal).padStart(2, "0")}`,
          backendId: job.backendId,
          ordinal,
          reservedWorkers: 0,
          phase: "RESERVED",
        };
      }
      project.reservedWorkers++;
      this.saveProject(project);
      job.projectKey = project.projectKey;
      this.saveJob(job);
      const worker = this.worker(job.workerId)!;
      worker.projectKey = project.projectKey;
      this.saveWorker(worker);
      return project;
    });
  }
  saveProject(project: FleetProject): void {
    this.sql.exec(
      "INSERT INTO projects VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      project.projectKey,
      project.backendId,
      JSON.stringify(project),
    );
  }
  jobs(): AllocationJob[] {
    return [...this.sql.exec<{ data: string }>("SELECT data FROM jobs")].map(
      (r) => JSON.parse(r.data) as AllocationJob,
    );
  }
  reserveTopicTitle(jobId: string): string {
    return this.transaction(() => {
      const job = this.job(jobId);
      if (!job) throw new Error("unknown_job");
      if (job.topicTitle) return job.topicTitle;
      const key = "topic-number:" + job.chatId;
      const row = [
        ...this.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key=?", key),
      ][0];
      const previous = row ? Number(JSON.parse(row.data)) : 0;
      if (!Number.isSafeInteger(previous) || previous < 0) throw new Error("invalid_topic_number");
      const next = previous + 1;
      this.sql.exec(
        "INSERT INTO ui_state(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
        key,
        JSON.stringify(next),
      );
      job.topicTitle = "#" + next;
      this.saveJob(job);
      return job.topicTitle;
    });
  }

  configureJob(jobId: string, patch: Partial<AllocationJob>): AllocationJob {
    return this.transaction(() => {
      const job = this.job(jobId);
      if (!job) throw new Error("unknown_job");
      if (
        (patch.workerId && patch.workerId !== job.workerId) ||
        (patch.generation && patch.generation !== job.generation) ||
        (patch.backendId && patch.backendId !== job.backendId)
      )
        throw new Error("job_identity_mismatch");
      Object.assign(job, patch);
      this.saveJob(job);
      const worker = this.worker(job.workerId)!;
      if (
        !worker ||
        worker.generation !== job.generation ||
        ["FENCING", "DELETING", "REPLACED"].includes(worker.state)
      )
        throw new Error("stale_generation");
      for (const key of [
        "projectId",
        "environmentId",
        "serviceId",
        "volumeId",
        "endpoint",
        "desiredImage",
      ] as const)
        if (patch[key] !== undefined) worker[key] = patch[key];
      this.saveWorker(worker);
      return job;
    });
  }
  issueBootstrap(jobId: string, hash: string, expires: number): void {
    const job = this.job(jobId);
    if (!job?.serviceId || !job.projectId) throw new Error("bootstrap_service_missing");
    this.transaction(() => {
      this.sql.exec("UPDATE bootstrap SET used=1 WHERE job=?", jobId);
      this.sql.exec("INSERT INTO bootstrap(hash,job,expires) VALUES(?,?,?)", hash, jobId, expires);
    });
  }
  bootstrapJob(hash: string): AllocationJob | undefined {
    const token = [
      ...this.sql.exec<{ job: string }>("SELECT job FROM bootstrap WHERE hash=?", hash),
    ][0];
    return token ? this.job(token.job) : undefined;
  }
  consumeBootstrap(
    hash: string,
    serviceId: string,
    projectId: string,
    now: number,
    credential?: string,
  ): AllocationJob {
    return this.transaction(() => {
      const token = [
        ...this.sql.exec<{ job: string; expires: number; used: number }>(
          "SELECT job,expires,used FROM bootstrap WHERE hash=?",
          hash,
        ),
      ][0];
      const job = token ? this.job(token.job) : undefined;
      if (
        !token ||
        token.used ||
        token.expires <= now ||
        !job ||
        job.serviceId !== serviceId ||
        job.projectId !== projectId ||
        this.worker(job.workerId)?.generation !== job.generation
      )
        throw new Error("bootstrap_rejected");
      this.sql.exec("UPDATE bootstrap SET used=1 WHERE hash=?", hash);
      if (credential) {
        const worker = this.worker(job.workerId)!;
        worker.credential = credential;
        this.saveWorker(worker);
      }
      return job;
    });
  }
  ready(workerId: string, generation: number, credential: string): void {
    const worker = this.worker(workerId);
    if (
      !worker ||
      worker.generation !== generation ||
      !["PROVISIONING", "READY_UNBOUND", "BINDING", "RECOVERING"].includes(worker.state)
    )
      throw new Error("stale_generation");
    worker.credential = credential;
    worker.state = worker.state === "BINDING" ? "BINDING" : "READY_UNBOUND";
    this.saveWorker(worker);
  }
  transition(workerId: string, generation: number, state: WorkerState): FleetWorker {
    const worker = this.worker(workerId);
    if (!worker || worker.generation !== generation) throw new Error("stale_generation");
    if (worker.state !== state && !transitions[worker.state].includes(state))
      throw new Error("invalid_worker_transition");
    worker.state = state;
    this.saveWorker(worker);
    return worker;
  }
  bindTopic(jobId: string, threadId: number, sessionId: string): FleetTopic {
    return this.transaction(() => {
      const job = this.job(jobId);
      if (!job || !Number.isSafeInteger(threadId) || threadId <= 1 || !sessionId)
        throw new Error("invalid_topic");
      const existing = this.topics().find(
        (t) => t.chatId === job.chatId && t.threadId === threadId,
      );
      if (existing) {
        if (
          existing.workerId !== job.workerId ||
          existing.generation !== job.generation ||
          existing.sessionId !== sessionId
        )
          throw new Error("topic_binding_mismatch");
        return existing;
      }
      const worker = this.worker(job.workerId);
      if (
        !worker ||
        worker.generation !== job.generation ||
        !worker.credential ||
        !["READY_UNBOUND", "BINDING"].includes(worker.state)
      )
        throw new Error("worker_not_ready");
      const topic: FleetTopic = {
        chatId: job.chatId,
        threadId,
        workerId: job.workerId,
        generation: job.generation,
        sessionId,
        state: "ACTIVE",
      };
      this.sql.exec(
        "INSERT INTO topics VALUES(?,?,?,?)",
        topic.chatId,
        topic.threadId,
        topic.workerId,
        JSON.stringify(topic),
      );
      worker.state = "BOUND_IDLE";
      this.saveWorker(worker);
      job.phase = "BOUND";
      job.threadId = threadId;
      this.saveJob(job);
      return topic;
    });
  }
  fenceTopic(chatId: number, threadId: number): FleetWorker {
    return this.transaction(() => {
      const topic = this.topics().find((t) => t.chatId === chatId && t.threadId === threadId);
      if (!topic) throw new Error("topic_missing");
      const worker = this.worker(topic.workerId)!;
      if (topic.state !== "FENCED") {
        worker.generation++;
        worker.state = "FENCING";
        this.saveWorker(worker);
        topic.state = "FENCED";
        topic.generation = worker.generation;
        this.sql.exec(
          "UPDATE topics SET data=? WHERE chat=? AND thread=?",
          JSON.stringify(topic),
          chatId,
          threadId,
        );
        this.sql.exec(
          "UPDATE runs SET state='CANCELLED' WHERE chat=? AND thread=? AND state IN ('ACTIVE','QUEUED')",
          chatId,
          threadId,
        );
      }
      return worker;
    });
  }
  pendingTopic(chatId: number, threadId: number): boolean {
    return this.all<AllocationJob>("jobs").some(
      (j) => j.chatId === chatId && j.threadId === threadId && j.phase !== "BOUND" && !j.error,
    );
  }
  fenceWorker(workerId: string): FleetWorker {
    return this.transaction(() => {
      const worker = this.worker(workerId);
      if (!worker) throw new Error("unknown_worker");
      if (this.topics().some((t) => t.workerId === workerId))
        throw new Error("topic_fence_required");
      if (!["FENCING", "DELETING", "REPLACED"].includes(worker.state)) {
        worker.generation++;
        worker.state = "FENCING";
        this.saveWorker(worker);
      }
      return worker;
    });
  }
  completeCleanup(workerId: string, generation: number): void {
    this.transaction(() => {
      const worker = this.worker(workerId);
      if (
        !worker ||
        worker.generation !== generation ||
        !["FENCING", "CLEANING"].includes(worker.state)
      )
        throw new Error("cleanup_not_confirmed");
      this.sql.exec("DELETE FROM topics WHERE worker=?", workerId);
      worker.state = "READY_UNBOUND";
      this.saveWorker(worker);
    });
  }
  recordVolumeDeletion(workerId: string, generation: number, pendingUntil: string): void {
    const worker = this.worker(workerId);
    if (
      !worker ||
      worker.generation !== generation ||
      worker.state !== "DELETING" ||
      !Number.isFinite(Date.parse(pendingUntil))
    )
      throw new Error("destructive_fence_required");
    worker.volumeDeletionPendingUntil = pendingUntil;
    this.saveWorker(worker);
  }
  confirmDestroyed(workerId: string, generation: number): void {
    this.transaction(() => {
      const worker = this.worker(workerId);
      if (!worker || worker.generation !== generation) throw new Error("stale_generation");
      if (!["FENCING", "DELETING", "REPLACED"].includes(worker.state))
        throw new Error("destructive_fence_required");
      if (worker.state === "REPLACED") return;
      this.sql.exec("DELETE FROM topics WHERE worker=?", workerId);
      const project = this.projects().find((p) => p.projectKey === worker.projectKey);
      if (project) {
        project.reservedWorkers = Math.max(0, project.reservedWorkers - 1);
        this.saveProject(project);
      }
      worker.state = "REPLACED";
      worker.credential = undefined;
      this.saveWorker(worker);
    });
  }
  saveObservation(
    workerId: string,
    generation: number,
    observation: {
      chatId?: number;
      threadId?: number;
      runtimeCommit?: string;
      runtimeVersion?: string;
      lastHealthAt?: number;
      revision?: number;
      volumeDeletionPendingUntil?: string;
      image?: string;
      deploymentId?: string;
    },
  ): void {
    const worker = this.worker(workerId);
    if (!worker || worker.generation !== generation) throw new Error("stale_generation");
    Object.assign(worker, observation);
    this.saveWorker(worker);
  }
  admitEvent(
    workerId: string,
    generation: number,
    nonce: string,
    timestamp: number,
    now: number,
    sessionId?: string,
  ): FleetWorker {
    return this.transaction(() => {
      const worker = this.worker(workerId);
      if (
        !worker ||
        worker.generation !== generation ||
        ["FENCING", "CLEANING", "REPLACED", "DELETING"].includes(worker.state)
      )
        throw new Error("stale_generation");
      if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > 60_000 || !nonce)
        throw new Error("timestamp_rejected");
      const topic = this.topics().find((t) => t.workerId === workerId);
      if (
        sessionId !== undefined &&
        (!topic || topic.sessionId !== sessionId || topic.state !== "ACTIVE")
      )
        throw new Error("session_mismatch");
      this.sql.exec("DELETE FROM nonces WHERE expires<=?", now);
      if (
        [
          ...this.sql.exec(
            "SELECT nonce FROM nonces WHERE worker=? AND generation=? AND nonce=?",
            workerId,
            generation,
            nonce,
          ),
        ].length
      )
        throw new Error("replay_rejected");
      this.sql.exec(
        "INSERT INTO nonces VALUES(?,?,?,?)",
        workerId,
        generation,
        nonce,
        now + 120_000,
      );
      return worker;
    });
  }
  enqueueVerified(
    chatId: number,
    threadId: number,
    request: string,
    prompt: string,
    generation: number,
    revision: number,
    model: string,
    operation: "run" | "session.compact" = "run",
  ): void {
    this.transaction(() => {
      const topic = this.topics().find((t) => t.chatId === chatId && t.threadId === threadId);
      if (topic?.generation !== generation) throw new Error("stale_generation");
      if (this.global()?.revision !== revision) throw new Error("configuration_changed");
      const prior = [...this.sql.exec("SELECT request FROM runs WHERE request=?", request)][0];
      if (prior && this.runOperation(request) !== operation)
        throw new Error("request_binding_mismatch");
      this.enqueue(chatId, threadId, request, prompt);
      this.pinRun(request, generation, revision, model);
      if (operation === "session.compact")
        this.sql.exec(
          "INSERT INTO ui_state(key,data) VALUES(?,?) ON CONFLICT(key) DO NOTHING",
          "operation:" + request,
          JSON.stringify(operation),
        );
    });
  }
  runOperation(request: string): "run" | "session.compact" {
    const row = [
      ...this.sql.exec<{ data: string }>(
        "SELECT data FROM ui_state WHERE key=?",
        "operation:" + request,
      ),
    ][0];
    if (!row) return "run";
    if (JSON.parse(row.data) !== "session.compact") throw new Error("invalid_run_operation");
    return "session.compact";
  }
  pinRun(request: string, generation: number, revision: number, model: string): void {
    this.sql.exec(
      "INSERT INTO run_pins(request,generation,revision,model) VALUES(?,?,?,?) ON CONFLICT(request) DO NOTHING",
      request,
      generation,
      revision,
      model,
    );
  }
  markRunDispatched(request: string): void {
    this.sql.exec("UPDATE run_pins SET dispatched=1 WHERE request=?", request);
  }
  runPin(
    request: string,
  ): { generation: number; revision: number; model: string; dispatched: number } | undefined {
    return [
      ...this.sql.exec<{ generation: number; revision: number; model: string; dispatched: number }>(
        "SELECT generation,revision,model,dispatched FROM run_pins WHERE request=?",
        request,
      ),
    ][0];
  }
  enqueue(chatId: number, threadId: number, requestId: string, prompt: string): void {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId) || !prompt || prompt.length > 20000)
      throw new Error("invalid_prompt");
    const previous = [
      ...this.sql.exec<{ chat: number; thread: number; prompt: string }>(
        "SELECT chat,thread,prompt FROM runs WHERE request=?",
        requestId,
      ),
    ][0];
    if (
      previous &&
      (previous.chat !== chatId || previous.thread !== threadId || previous.prompt !== prompt)
    )
      throw new Error("request_identity_mismatch");
    if (
      !this.topics().some(
        (t) => t.chatId === chatId && t.threadId === threadId && t.state === "ACTIVE",
      )
    )
      throw new Error("topic_not_writable");
    this.sql.exec(
      "INSERT INTO runs(request,chat,thread,prompt) VALUES(?,?,?,?) ON CONFLICT(request) DO NOTHING",
      requestId,
      chatId,
      threadId,
      prompt,
    );
  }
  startNext(chatId: number, threadId: number): Run | undefined {
    return this.transaction(() => {
      if (
        [
          ...this.sql.exec(
            "SELECT request FROM runs WHERE chat=? AND thread=? AND state='ACTIVE'",
            chatId,
            threadId,
          ),
        ].length
      )
        return;
      const run = [
        ...this.sql.exec<{
          requestId: string;
          chatId: number;
          threadId: number;
          prompt: string;
          state: string;
        }>(
          "SELECT request AS requestId,chat AS chatId,thread AS threadId,prompt,state FROM runs WHERE chat=? AND thread=? AND state='QUEUED' ORDER BY seq LIMIT 1",
          chatId,
          threadId,
        ),
      ][0];
      if (!run) return;
      this.sql.exec("UPDATE runs SET state='ACTIVE' WHERE request=?", run.requestId);
      return { ...run, state: "ACTIVE" };
    });
  }
  finishRun(chatId: number, threadId: number, requestId: string): void {
    this.sql.exec(
      "UPDATE runs SET state='COMPLETED' WHERE request=? AND chat=? AND thread=? AND state='ACTIVE'",
      requestId,
      chatId,
      threadId,
    );
  }
  setGlobal(
    data: Record<string, unknown>,
    hash: string,
    expectedRevision?: number,
    approval?: { id: string; data: Record<string, unknown> },
  ): { revision: number; hash: string; data: Record<string, unknown> } {
    return this.transaction(() => {
      if (!hash || !data || typeof data !== "object") throw new Error("invalid_snapshot");
      const previous = this.global()?.revision ?? 0;
      if (expectedRevision !== undefined && previous !== expectedRevision)
        throw new Error("snapshot_revision_conflict");
      const revision = previous + 1;
      this.sql.exec(
        "INSERT INTO global_state VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,hash=excluded.hash,data=excluded.data",
        revision,
        hash,
        JSON.stringify(data),
      );
      if (approval) {
        const current = [
          ...this.sql.exec<{ state: string }>(
            "SELECT state FROM approvals WHERE id=?",
            approval.id,
          ),
        ][0];
        if (current?.state !== "APPROVED") throw new Error("approval_required");
        this.sql.exec(
          "UPDATE approvals SET state='COMMITTED',data=? WHERE id=?",
          JSON.stringify(approval.data),
          approval.id,
        );
      }
      return { revision, hash, data };
    });
  }
  global(): { revision: number; hash: string; data: Record<string, unknown> } | undefined {
    const row = [
      ...this.sql.exec<{ revision: number; hash: string; data: string }>(
        "SELECT revision,hash,data FROM global_state WHERE id=1",
      ),
    ][0];
    return row ? { ...row, data: JSON.parse(row.data) } : undefined;
  }
}
