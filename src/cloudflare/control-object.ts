import type { DurableObjectState } from "@cloudflare/workers-types";
import type { ControlEnvironment } from "./worker.js";
import { ControlStore, type AllocationJob } from "./control-store.js";
import { decryptCredential, encryptCredential, randomSecret, sha256 } from "./credentials.js";
import { RailwayFleetDriver, railwayApi } from "./railway-fleet-driver.js";
import { canonical, signEnvelope, verifyEnvelope } from "./protocol.js";

export class ControlPlane {
  private readonly store: ControlStore;
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: ControlEnvironment,
  ) {
    this.store = new ControlStore(state.storage.sql, (action) =>
      state.storage.transactionSync(action),
    );
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/admin/inventory")
        return Response.json({
          backends: this.store
            .backends()
            .map(({ credential: _credential, ...publicData }) => publicData),
          projects: this.store.projects(),
          workers: this.store
            .workers()
            .map(({ credential: _credential, ...publicData }) => publicData),
          topics: this.store.topics(),
        });
      const raw = await request.text();
      const body = JSON.parse(raw) as Record<string, unknown>;
      if (path === "/admin/backends") {
        const backendId = String(body.backendId ?? "");
        const credential = await encryptCredential(
          this.env.CREDENTIAL_MASTER_KEY,
          "backend:" + backendId,
          String(body.token ?? ""),
        );
        this.store.putBackend({
          backendId,
          workspaceId: String(body.workspaceId ?? ""),
          credential,
          region: String(body.region ?? "europe-west4"),
          desiredMaximumWorkers: Number(body.desiredMaximumWorkers ?? 10),
          maxWorkersPerProject: Number(body.maxWorkersPerProject ?? 5),
          enabled: body.enabled !== false,
        });
        return Response.json({ ok: true });
      }
      if (path === "/admin/global") {
        const previous = this.store.global();
        const revision = (previous?.revision ?? 0) + 1;
        const snapshot = { ...body, version: 1, revision };
        const hash = await sha256(canonical(snapshot));
        this.store.setGlobal(snapshot, hash, revision - 1);
        return Response.json({ revision, hash });
      }
      if (path === "/telegram/webhook") {
        if (!Number.isSafeInteger(body.update_id))
          return Response.json({ error: "invalid_update" }, { status: 400 });
        this.state.storage.sql.exec(
          "INSERT INTO updates(id,data) VALUES(?,?) ON CONFLICT(id) DO NOTHING",
          Number(body.update_id),
          JSON.stringify(body),
        );
        await this.state.storage.setAlarm(Date.now() + 1);
        return Response.json({ ok: true });
      }
      if (path === "/jobs/advance") {
        if (this.env.PROVISIONING_ENABLED !== "true") throw new Error("provisioning_disabled");
        const jobId = String(body.jobId);
        const job = this.store.job(jobId);
        if (!job) throw new Error("unknown_job");
        const owner = crypto.randomUUID();
        if (!this.store.acquireLease("railway-provisioning", owner, Date.now(), 180_000))
          throw new Error("provisioning_pending");
        try {
          const backend = this.store.backends().find((b) => b.backendId === job.backendId)!;
          const token = await decryptCredential(
            this.env.CREDENTIAL_MASTER_KEY,
            "backend:" + backend.backendId,
            backend.credential,
          );
          const api = railwayApi(token);
          const driver = new RailwayFleetDriver(
            this.store,
            async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
              this.store.renewLease("railway-provisioning", owner, Date.now(), 180_000);
              return api<T>(query, variables);
            },
            {
              image: this.env.WORKER_IMAGE,
              controlUrl: this.env.CONTROL_PLANE_URL,
              bootstrap: async (job: AllocationJob) => {
                const token = randomSecret();
                this.store.issueBootstrap(job.jobId, await sha256(token), Date.now() + 15 * 60_000);
                return token;
              },
            },
          );
          await driver.provision(jobId);
          return Response.json({ ok: true, phase: this.store.job(jobId)?.phase });
        } finally {
          this.store.releaseLease("railway-provisioning", owner);
        }
      }
      if (path === "/nodes/bootstrap") {
        const secret = randomSecret();
        const hash = await sha256(String(body.bootstrapToken ?? ""));
        const pending = this.store.bootstrapJob(hash);
        if (!pending) throw new Error("bootstrap_rejected");
        const encrypted = await encryptCredential(
          this.env.CREDENTIAL_MASTER_KEY,
          "node:" + pending.workerId + ":" + pending.generation,
          secret,
        );
        const job = this.store.consumeBootstrap(
          hash,
          String(body.serviceId ?? ""),
          String(body.projectId ?? ""),
          Date.now(),
          encrypted,
        );
        return Response.json({
          version: 1,
          identity: { nodeId: job.workerId, generation: job.generation, chatId: 0, threadId: 0 },
          secret,
          revision: this.store.global()?.revision ?? 0,
        });
      }
      if (path === "/node-control" || path === "/nodes/events") {
        const worker = this.store.worker(String(body.nodeId ?? ""));
        if (!worker?.credential) throw new Error("node_unknown");
        const secret = await decryptCredential(
          this.env.CREDENTIAL_MASTER_KEY,
          "node:" + worker.workerId + ":" + worker.generation,
          worker.credential,
        );
        // Verify the exact received bytes, not a re-serialized authentication body.
        const envelope = await verifyEnvelope(
          raw,
          request.headers.get("x-node-signature") ?? "",
          secret,
        );
        const topic = this.store.topics().find((t) => t.workerId === worker.workerId);
        if (
          envelope.chatId !== (topic?.chatId ?? 0) ||
          envelope.threadId !== (topic?.threadId ?? 0)
        )
          throw new Error("topic_mismatch");
        this.store.admitEvent(
          worker.workerId,
          envelope.generation,
          envelope.nonce,
          envelope.timestamp,
          Date.now(),
          envelope.sessionId,
        );
        if (envelope.operation === "snapshot.get") {
          const global = this.store.global();
          if (!global) throw new Error("snapshot_unavailable");
          return this.signed(envelope, secret, { ...global.data, hash: global.hash });
        }
        throw new Error("unsupported_node_operation");
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      const category =
        error instanceof Error && /^[a-z_]+$/.test(error.message)
          ? error.message
          : "control_operation_failed";
      // Fixed categories only; request bodies, backend credentials and signatures never enter logs.
      // Cloudflare captures native console output; the Node file logger cannot run here.
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ event: "control_operation_failed", category }));
      return Response.json({ error: category }, { status: 409 });
    }
  }
  private async signed(
    envelope: Parameters<typeof signEnvelope>[0],
    secret: string,
    result: unknown,
  ): Promise<Response> {
    const signed = await signEnvelope(
      { ...envelope, payload: result, timestamp: Date.now(), nonce: randomSecret() },
      secret,
    );
    return new Response(signed.body, {
      headers: { "Content-Type": "application/json", "x-node-signature": signed.signature },
    });
  }
  async alarm(): Promise<void> {
    const rows = [
      ...this.state.storage.sql.exec<{ id: number; data: string }>(
        "SELECT id,data FROM updates WHERE state='PENDING' ORDER BY id LIMIT 20",
      ),
    ];
    for (const row of rows) {
      const update = JSON.parse(row.data) as {
        message?: { text?: string; chat: { id: number }; from?: { id: number } };
        callback_query?: {
          data?: string;
          from: { id: number };
          message?: { chat: { id: number } };
        };
      };
      const actor = update.message?.from?.id ?? update.callback_query?.from.id;
      const allowed = this.env.TELEGRAM_ALLOWED_USER_IDS.split(",").map((v) => Number(v.trim()));
      if (!actor || !allowed.includes(actor)) {
        this.state.storage.sql.exec("UPDATE updates SET state='REJECTED' WHERE id=?", row.id);
        continue;
      }
      const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
      const action = update.message?.text ?? update.callback_query?.data;
      if (chatId && (action === "/new" || action === "new_chat")) {
        try {
          const job = this.store.reserveAllocation("telegram:" + row.id, chatId);
          await this.env.JOBS.send({ jobId: job.jobId });
          this.state.storage.sql.exec("UPDATE updates SET state='DISPATCHED' WHERE id=?", row.id);
        } catch {
          await this.state.storage.setAlarm(Date.now() + 30_000);
        }
      } else
        this.state.storage.sql.exec("UPDATE updates SET state='UNSUPPORTED' WHERE id=?", row.id);
    }
    if (
      [...this.state.storage.sql.exec("SELECT id FROM updates WHERE state='PENDING' LIMIT 1")]
        .length
    )
      await this.state.storage.setAlarm(Date.now() + 30_000);
  }
}
