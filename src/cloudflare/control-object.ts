import type { DurableObjectState } from "@cloudflare/workers-types";
import type { ControlEnvironment } from "./worker.js";
import { ControlStore, type AllocationJob } from "./control-store.js";
import { decryptCredential, encryptCredential, randomSecret, sha256 } from "./credentials.js";
import { RailwayFleetDriver, railwayApi } from "./railway-fleet-driver.js";
import { nodeRpc, type RpcIdentity } from "./node-rpc.js";
import { CloudTelegram, TelegramDeliveryError } from "./telegram.js";
import { renderTelegramParts } from "../bot/render/pipeline.js";
import { en } from "../i18n/en.js";
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
      if (path === "/admin/setup") {
        await this.setup();
        return Response.json({ ok: true });
      }
      if (path === "/admin/railway-status") {
        const api = railwayApi(this.env.RAILWAY_API_TOKEN);
        const inventory = await api<{
          workspace: {
            projects: {
              edges: Array<{ node: { id: string; name: string } }>;
              pageInfo: { hasNextPage: boolean };
            };
          };
        }>(
          "query ControlProjects($workspaceId:String!){workspace(workspaceId:$workspaceId){projects{edges{node{id name}} pageInfo{hasNextPage}}}}",
          { workspaceId: this.env.RAILWAY_WORKSPACE_ID },
        );
        return Response.json({
          projects: inventory.workspace.projects.edges.map((e) => e.node),
          hasNextPage: inventory.workspace.projects.pageInfo.hasNextPage,
        });
      }
      if (path === "/admin/topics") {
        await this.setup();
        const threadId = Number(body.threadId);
        if (!Number.isSafeInteger(threadId) || threadId <= 1) throw new Error("invalid_topic");
        const job = this.store.reserveTopicAllocation(
          String(body.requestId ?? ""),
          Number(body.chatId),
          threadId,
        );
        if (job.threadId !== undefined && job.threadId !== threadId)
          throw new Error("topic_binding_mismatch");
        this.store.configureJob(job.jobId, { threadId });
        this.store.saveObservation(job.workerId, job.generation, { chatId: job.chatId, threadId });
        await this.env.JOBS.send({ jobId: job.jobId });
        return Response.json({ jobId: job.jobId, workerId: job.workerId, phase: job.phase });
      }
      if (path === "/admin/telegram") {
        if (!this.env.TELEGRAM_BOT_TOKEN || !this.env.TELEGRAM_WEBHOOK_SECRET)
          throw new Error("telegram_not_configured");
        const telegram = new CloudTelegram(this.env.TELEGRAM_BOT_TOKEN);
        const me = await telegram.call<{ id: number; username: string }>("getMe", {});
        if (body.connect === true)
          await telegram.call("setWebhook", {
            url: this.env.CONTROL_PLANE_URL + "/telegram/webhook",
            secret_token: this.env.TELEGRAM_WEBHOOK_SECRET,
            allowed_updates: ["message", "callback_query"],
          });
        const hook = await telegram.call<{ url: string; pending_update_count: number }>(
          "getWebhookInfo",
          {},
        );
        return Response.json({
          botId: me.id,
          username: me.username,
          webhook: hook.url,
          pending: hook.pending_update_count,
          admissionConfigured: Boolean(
            this.env.TELEGRAM_ALLOWED_USER_ID || this.env.TELEGRAM_ALLOWED_USER_IDS,
          ),
        });
      }
      if (path === "/admin/job") {
        const job = this.store.job(String(body.jobId));
        return Response.json({ job });
      }
      if (path === "/admin/delete-topic") {
        await this.deleteTopic(Number(body.chatId), Number(body.threadId));
        return Response.json({ ok: true });
      }
      if (path === "/admin/rpc") {
        const topic = this.store
          .topics()
          .find(
            (t) =>
              t.chatId === Number(body.chatId) &&
              t.threadId === Number(body.threadId) &&
              t.state === "ACTIVE",
          );
        if (!topic) throw new Error("topic_not_writable");
        const operation = String(body.operation);
        if (!["session.get", "session.messages", "status", "health"].includes(operation))
          throw new Error("operation_not_allowed");
        return Response.json({
          result: await nodeRpc(
            await this.identity(topic.workerId),
            operation,
            {},
            operation === "health" ? undefined : topic.sessionId,
          ),
        });
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
        await this.advance(String(body.jobId));
        return Response.json({ ok: true });
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
          identity: {
            nodeId: job.workerId,
            generation: job.generation,
            chatId: job.chatId,
            threadId: job.threadId,
          },
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
          envelope.chatId !== (topic?.chatId ?? worker.chatId ?? 0) ||
          envelope.threadId !== (topic?.threadId ?? worker.threadId ?? 0)
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
        if (envelope.operation === "session.event") {
          if (!topic || topic.state !== "ACTIVE") throw new Error("topic_not_writable");
          this.store.recordCallback(
            topic.chatId,
            topic.threadId,
            envelope.payload as Record<string, unknown>,
          );
          await this.state.storage.setAlarm(Date.now() + 1);
          return this.signed(envelope, secret, { accepted: true });
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
  private async setup(): Promise<void> {
    if (!this.env.RAILWAY_API_TOKEN || !this.env.RAILWAY_WORKSPACE_ID)
      throw new Error("railway_backend_not_configured");
    const maximum = Number(this.env.MAX_WORKERS),
      perProject = Number(this.env.WORKERS_PER_PROJECT),
      maxProjects = Number(this.env.MAX_RAILWAY_PROJECTS);
    if (![maximum, perProject, maxProjects].every((v) => Number.isSafeInteger(v) && v > 0))
      throw new Error("invalid_capacity_policy");
    this.store.putBackend({
      backendId: "railway",
      workspaceId: this.env.RAILWAY_WORKSPACE_ID,
      credential: "binding:RAILWAY_API_TOKEN",
      region: "europe-west4",
      desiredMaximumWorkers: maximum,
      maxWorkersPerProject: perProject,
      maxProjects,
      enabled: true,
    });
    if (!this.store.global()) {
      const snapshot = {
        version: 1,
        revision: 1,
        configuration: { runtime: {} },
        skills: [],
        actions: [],
        catalog: {},
        defaults: {},
        credentialReferences: [],
      };
      this.store.setGlobal(snapshot, await sha256(canonical(snapshot)), 0);
    }
  }
  private driver(guard?: () => void): RailwayFleetDriver {
    const api = railwayApi(this.env.RAILWAY_API_TOKEN);
    const request = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
      guard?.();
      const result = await api<T>(query, variables);
      guard?.();
      return result;
    };
    return new RailwayFleetDriver(this.store, request, {
      image: this.env.WORKER_IMAGE,
      controlUrl: this.env.CONTROL_PLANE_URL,
      bootstrap: async (job: AllocationJob) => {
        const token = randomSecret();
        const hash = await sha256(token);
        guard?.();
        this.store.issueBootstrap(job.jobId, hash, Date.now() + 15 * 60_000);
        return token;
      },
    });
  }
  private async identity(workerId: string, generation?: number): Promise<RpcIdentity> {
    const worker = this.store.worker(workerId);
    if (!worker?.credential || !worker.endpoint || !worker.chatId || !worker.threadId)
      throw new Error("worker_not_ready");
    const selected = generation ?? worker.generation;
    const secret = await decryptCredential(
      this.env.CREDENTIAL_MASTER_KEY,
      "node:" + workerId + ":" + selected,
      worker.credential,
    );
    return {
      workerId,
      generation: selected,
      chatId: worker.chatId,
      threadId: worker.threadId,
      endpoint: worker.endpoint,
      secret,
    };
  }
  private async advance(jobId: string): Promise<void> {
    if (this.env.PROVISIONING_ENABLED !== "true") throw new Error("provisioning_disabled");
    const job = this.store.job(jobId);
    if (!job) throw new Error("unknown_job");
    if (job.phase === "BOUND") return;
    if (job.error) throw new Error(job.error);
    if (job.createdAt && Date.now() - job.createdAt > 20 * 60_000) {
      this.store.configureJob(jobId, {
        phase: "RECONCILIATION_REQUIRED",
        error: "worker_bootstrap_timeout",
      });
      this.store.transition(job.workerId, job.generation, "UNHEALTHY");
      throw new Error("worker_bootstrap_timeout");
    }
    if (!job.threadId) throw new Error("topic_pending");
    const owner = crypto.randomUUID();
    if (!this.store.acquireLease("railway-provisioning", owner, Date.now(), 180_000))
      throw new Error("provisioning_pending");
    const guard = () => {
      this.store.renewLease("railway-provisioning", owner, Date.now(), 180_000);
      const current = this.store.worker(job.workerId);
      if (
        !current ||
        current.generation !== job.generation ||
        ["FENCING", "DELETING", "REPLACED"].includes(current.state)
      )
        throw new Error("stale_generation");
    };
    try {
      await this.driver(guard).provision(jobId);
      const worker = this.store.worker(job.workerId)!;
      if (!worker.credential) {
        await this.state.storage.setAlarm(Date.now() + 15_000);
        return;
      }
      const identity = await this.identity(worker.workerId);
      let health: {
        ready: boolean;
        runtime?: { telegramCoreCommit: string; telegramCoreVersion: string };
      };
      try {
        health = await nodeRpc(identity, "health", {});
      } catch {
        await this.state.storage.setAlarm(Date.now() + 15_000);
        return;
      }
      guard();
      if (!health.ready) {
        await this.state.storage.setAlarm(Date.now() + 15_000);
        return;
      }
      if (
        health.runtime?.telegramCoreCommit !== this.env.WORKER_CORE_COMMIT ||
        health.runtime?.telegramCoreVersion !== this.env.WORKER_CORE_VERSION
      )
        throw new Error("worker_image_mismatch");
      guard();
      const session = await nodeRpc<{ sessionId: string }>(identity, "session.create", {});
      guard();
      this.store.saveObservation(worker.workerId, job.generation, {
        runtimeCommit: health.runtime.telegramCoreCommit,
        runtimeVersion: health.runtime.telegramCoreVersion,
        lastHealthAt: Date.now(),
      });
      this.store.ready(worker.workerId, job.generation, worker.credential!);
      this.store.bindTopic(jobId, job.threadId, session.sessionId);
    } finally {
      this.store.releaseLease("railway-provisioning", owner);
    }
  }
  private async deleteTopic(chatId: number, threadId: number): Promise<void> {
    const topic = this.store.topics().find((t) => t.chatId === chatId && t.threadId === threadId);
    if (!topic) return;
    const previousGeneration = topic.state === "FENCED" ? topic.generation - 1 : topic.generation;
    const worker = this.store.fenceTopic(chatId, threadId);
    try {
      await nodeRpc(await this.identity(worker.workerId, previousGeneration), "retire", {});
    } catch {
      /* Destruction is mandatory if retirement cannot prove process join. */
    }
    this.store.transition(worker.workerId, worker.generation, "DELETING");
    await this.driver().destroy(worker.workerId, worker.generation);
    this.store.confirmDestroyed(worker.workerId, worker.generation);
  }
  async alarm(): Promise<void> {
    const pending = [...this.state.storage.sql.exec<{ data: string }>("SELECT data FROM jobs")]
      .map((r) => JSON.parse(r.data) as AllocationJob)
      .filter((j) => ["DEPLOYING", "DEPLOY_SUBMITTED"].includes(j.phase));
    for (const job of pending) {
      try {
        await this.advance(job.jobId);
      } catch {
        await this.state.storage.setAlarm(Date.now() + 30_000);
      }
    }

    for (const topic of this.store.topics().filter((t) => t.state === "ACTIVE")) {
      const run =
        this.store.activeRuns(topic.chatId, topic.threadId)[0] ??
        this.store.startNext(topic.chatId, topic.threadId);
      if (!run || this.store.worker(topic.workerId)?.state === "UNHEALTHY") continue;
      const owner = crypto.randomUUID(),
        lease = "dispatch:" + run.requestId;
      if (!this.store.acquireLease(lease, owner, Date.now(), 60_000)) continue;
      try {
        const reply = await nodeRpc<{ accepted: boolean }>(
          await this.identity(topic.workerId),
          "run",
          { runId: run.requestId, text: run.prompt, events: true },
          topic.sessionId,
        );

        const status = await nodeRpc<{ state: string }>(
          await this.identity(topic.workerId),
          "callback.status",
          { runId: run.requestId },
          topic.sessionId,
        );
        if (!reply.accepted && !["INCOMPLETE", "SUBMITTED"].includes(status.state))
          throw new Error("execution_not_accepted");
        if (["INCOMPLETE", "SUBMITTED"].includes(status.state)) {
          await nodeRpc(
            await this.identity(topic.workerId),
            "stop",
            { runId: run.requestId },
            topic.sessionId,
          );
          const active = await nodeRpc(
            await this.identity(topic.workerId),
            "status",
            {},
            topic.sessionId,
          );
          if (active) throw new Error("execution_cleanup_pending");
          this.store.failRun(
            topic.chatId,
            topic.threadId,
            run.requestId,
            en["bot.prompt_send_error"],
          );
        }
        this.store.releaseLease(lease, owner);
        if (this.store.activeRuns(topic.chatId, topic.threadId).length)
          await this.state.storage.setAlarm(Date.now() + 30_000);
      } catch {
        this.store.releaseLease(lease, owner);
        await this.state.storage.setAlarm(Date.now() + 15_000);
      }
    }
    for (const response of this.store.completedResponses()) {
      const parts = renderTelegramParts(response.text),
        telegram = new CloudTelegram(this.env.TELEGRAM_BOT_TOKEN);
      let complete = true;
      for (let index = 0; index < parts.length; index++) {
        const id = response.run + ":" + index;
        const previous = [
          ...this.state.storage.sql.exec<{ state: string }>(
            "SELECT state FROM outbox WHERE id=?",
            id,
          ),
        ][0];
        if (previous?.state === "DELIVERED") continue;
        if (previous?.state === "SENDING" || previous?.state === "RECONCILIATION_REQUIRED") {
          this.store.responseDelivered(response.run, "RECONCILIATION_REQUIRED");
          complete = false;
          break;
        }
        this.state.storage.sql.exec(
          "INSERT INTO outbox VALUES(?,?,'SENDING') ON CONFLICT(id) DO UPDATE SET state='SENDING'",
          id,
          JSON.stringify({ run: response.run, index }),
        );
        try {
          await telegram.sendPart(response.chat, response.thread, parts[index]!);
          this.state.storage.sql.exec("UPDATE outbox SET state='DELIVERED' WHERE id=?", id);
        } catch (error) {
          const state =
            error instanceof TelegramDeliveryError && error.category === "rate_limited"
              ? "PENDING"
              : "RECONCILIATION_REQUIRED";
          this.state.storage.sql.exec("UPDATE outbox SET state=? WHERE id=?", state, id);
          if (state === "PENDING") await this.state.storage.setAlarm(Date.now() + 30_000);
          else this.store.responseDelivered(response.run, state);
          complete = false;
          break;
        }
      }
      if (complete) {
        this.store.responseDelivered(response.run);
        await this.state.storage.setAlarm(Date.now() + 1);
      }
    }
    const rows = [
      ...this.state.storage.sql.exec<{ id: number; data: string }>(
        "SELECT id,data FROM updates WHERE state='PENDING' ORDER BY id LIMIT 20",
      ),
    ];
    for (const row of rows) {
      const update = JSON.parse(row.data) as {
        message?: {
          text?: string;
          message_thread_id?: number;
          chat: { id: number };
          from?: { id: number };
        };
        callback_query?: {
          data?: string;
          id?: string;
          from: { id: number };
          message?: { chat: { id: number } };
        };
      };
      const actor = update.message?.from?.id ?? update.callback_query?.from.id;
      const allowed = (
        this.env.TELEGRAM_ALLOWED_USER_IDS ??
        this.env.TELEGRAM_ALLOWED_USER_ID ??
        ""
      )
        .split(",")
        .map((v) => Number(v.trim()));
      if (!actor || !allowed.includes(actor)) {
        this.state.storage.sql.exec("UPDATE updates SET state='REJECTED' WHERE id=?", row.id);
        continue;
      }
      const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
      const action = update.message?.text ?? update.callback_query?.data;
      const telegram = new CloudTelegram(this.env.TELEGRAM_BOT_TOKEN);
      try {
        if (update.callback_query?.id)
          await telegram.call("answerCallbackQuery", {
            callback_query_id: update.callback_query.id,
          });
        if (chatId && (action === "/new" || action === "new_chat" || action === "main:new")) {
          if (
            this.env.PROVISION_ON_TOPIC_CREATE !== "true" ||
            this.env.PROVISIONING_ENABLED !== "true"
          )
            throw new Error("provisioning_disabled");
          await this.setup();
          const job = this.store.reserveAllocation("telegram_" + row.id, chatId);
          if (!job.threadId) {
            if (job.phase === "TOPIC_CREATING")
              throw new Error("topic_creation_reconciliation_required");
            this.store.configureJob(job.jobId, { phase: "TOPIC_CREATING" });
            const created = await telegram.call<{ message_thread_id: number }>("createForumTopic", {
              chat_id: chatId,
              name: "OpenCode",
            });
            this.store.configureJob(job.jobId, {
              threadId: created.message_thread_id,
              phase: "PROVISIONING",
            });
            this.store.saveObservation(job.workerId, job.generation, {
              chatId,
              threadId: created.message_thread_id,
            });
          }
          await this.env.JOBS.send({ jobId: job.jobId });
          await telegram.send(chatId, job.threadId, en["bot.creating_session"]);
        } else if (chatId && action === "/start") {
          await telegram.call("sendMessage", {
            chat_id: chatId,
            text: "OpenCode",
            reply_markup: { inline_keyboard: [[{ text: "New Chat", callback_data: "main:new" }]] },
          });
        } else if (chatId && action === "/delete" && update.message?.message_thread_id) {
          const threadId = update.message.message_thread_id;
          await this.deleteTopic(chatId, threadId);
          await telegram.call("deleteForumTopic", { chat_id: chatId, message_thread_id: threadId });
        } else if (chatId && update.message?.text && update.message.message_thread_id) {
          this.store.enqueue(
            chatId,
            update.message.message_thread_id,
            "telegram_" + row.id,
            update.message.text,
          );
          await this.state.storage.setAlarm(Date.now() + 1);
        }
        this.state.storage.sql.exec("UPDATE updates SET state='DISPATCHED' WHERE id=?", row.id);
      } catch (error) {
        // Ambiguous Topic creation must not be retried into a second Telegram Topic.
        if (error instanceof TelegramDeliveryError && error.category === "rate_limited") {
          await this.state.storage.setAlarm(Date.now() + 30_000);
          continue;
        }
        this.state.storage.sql.exec("UPDATE updates SET state='FAILED' WHERE id=?", row.id);
        if (chatId)
          try {
            await telegram.send(
              chatId,
              undefined,
              error instanceof Error &&
                ["capacity_exhausted", "project_capacity_exhausted"].includes(error.message)
                ? en["new.capacity_exhausted"]
                : en["new.create_error"],
            );
          } catch {
            /* Persisted failure is available to authenticated reconciliation. */
          }
      }
    }
    if (
      [...this.state.storage.sql.exec("SELECT id FROM updates WHERE state='PENDING' LIMIT 1")]
        .length
    )
      await this.state.storage.setAlarm(Date.now() + 30_000);
  }
}
