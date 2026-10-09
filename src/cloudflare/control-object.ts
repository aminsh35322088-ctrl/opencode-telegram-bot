import { CloudIntegrationConnections } from "./integration-connections.js";
import type { DurableObjectState } from "@cloudflare/workers-types";
import type { ControlEnvironment } from "./worker.js";
import { ControlStore, type AllocationJob } from "./control-store.js";
import { decryptCredential, encryptCredential, randomSecret, sha256 } from "./credentials.js";
import { RailwayFleetDriver, railwayApi } from "./railway-fleet-driver.js";
import { nodeRpc, type RpcIdentity } from "./node-rpc.js";
import { CloudTelegram, TelegramDeliveryError } from "./telegram.js";
import { telegramMediaParts, type CloudPromptPart } from "./media.js";
import { renderTelegramParts } from "../bot/render/pipeline.js";
import { en } from "../i18n/en.js";
import { canonical, signEnvelope, verifyEnvelope } from "./protocol.js";
import { CloudRunUi } from "./run-ui.js";
import { CloudTopicTitleUi } from "./topic-title-ui.js";
import { CloudTaskUi } from "./task-ui.js";
import {
  CloudCredentialVault,
  protectTelegramCredentialUpdate,
  readCredentialInput,
  type ProtectedTelegramUpdate,
} from "./credential-vault.js";
import { applyGlobalConfigMutation } from "./config-ui.js";
import { WorkerImageUpgrade, isWorkerImageUpgrading } from "./worker-image-upgrade.js";
import { LegacyUiAdapter } from "./legacy-ui-adapter.js";
import packageJson from "../../package.json" with { type: "json" };
import { CloudBotUi, supportsContextCompaction, type TelegramUpdate } from "./bot-ui.js";

import { CONTROL_DEFAULTS } from "./control-config.js";
import { resolveControlSecrets, equalSecret } from "./control-secrets.js";

export class ControlPlane {
  private readonly store: ControlStore;
  private readonly env: ControlEnvironment;
  private secretsReady?: Promise<void>;
  private alarmScheduling: Promise<void> = Promise.resolve();
  constructor(
    private readonly state: DurableObjectState,
    env: ControlEnvironment,
  ) {
    this.env = { ...CONTROL_DEFAULTS, ...env };
    this.store = new ControlStore(state.storage.sql, (action) =>
      state.storage.transactionSync(action),
    );
  }
  private async scheduleAlarm(at: number): Promise<void> {
    const next = this.alarmScheduling.then(async () => {
      const current =
        typeof this.state.storage.getAlarm === "function"
          ? await this.state.storage.getAlarm()
          : null;
      if (current === null || at < current) await this.state.storage.setAlarm(at);
    });
    this.alarmScheduling = next.catch(() => {});
    await next;
  }
  private async refreshTyping(
    topic: import("./control-store.js").FleetTopic,
    runId: string,
  ): Promise<void> {
    const key = `typing:${runId}`;
    const row = [
      ...this.state.storage.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key=?", key),
    ][0];
    const previous = row ? (JSON.parse(row.data) as { nextAt?: number }) : undefined;
    const now = Date.now();
    if ((previous?.nextAt ?? 0) > now) {
      await this.scheduleAlarm(previous!.nextAt!);
      return;
    }
    let delay = 4_000;
    try {
      await new CloudTelegram(this.env.TELEGRAM_BOT_TOKEN).call("sendChatAction", {
        chat_id: topic.chatId,
        message_thread_id: topic.threadId,
        action: "typing",
      });
    } catch (error) {
      if (error instanceof TelegramDeliveryError && error.category === "rate_limited")
        delay = Math.max(delay, (error.retryAfter ?? 1) * 1_000);
      // Typing is best-effort presentation and must never block execution.
    }
    const nextAt = Date.now() + delay;
    this.state.storage.sql.exec(
      "INSERT INTO ui_state(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
      key,
      JSON.stringify({ nextAt, chat: topic.chatId, thread: topic.threadId, generation: topic.generation }),
    );
    await this.scheduleAlarm(nextAt);
  }
  private clearInactiveTyping(): void {
    this.state.storage.sql.exec(
      "DELETE FROM ui_state WHERE key GLOB 'typing:*' AND substr(key,8) NOT IN (SELECT request FROM runs WHERE state='ACTIVE')",
    );
  }

  private async initializeSecrets(): Promise<void> {
    // Legacy test/installation paths lacking root bindings remain backward compatible.
    if (!this.env.TELEGRAM_BOT_TOKEN || !this.env.RAILWAY_API_TOKEN) return;
    this.secretsReady ??= resolveControlSecrets(this.state.storage.sql, this.env)
      .then((value) => {
        Object.assign(this.env, value);
      })
      .catch((error: unknown) => {
        this.secretsReady = undefined;
        throw error;
      });
    await this.secretsReady;
  }
  async fetch(request: Request): Promise<Response> {
    try {
      await this.initializeSecrets();
      const path = new URL(request.url).pathname;
      if (path === "/control/auth") {
        const input = await request.text();
        if (input.length > 1024) return new Response("Unauthorized", { status: 401 });
        const value = JSON.parse(input) as { kind?: string; supplied?: string };
        const expected =
          value.kind === "webhook"
            ? this.env.TELEGRAM_WEBHOOK_SECRET
            : value.kind === "admin" && this.env.ADMIN_TOKEN
              ? "Bearer " + this.env.ADMIN_TOKEN
              : "";
        return Response.json({
          authorized:
            typeof value.supplied === "string" &&
            !!expected &&
            (await equalSecret(value.supplied, expected)),
        });
      }
      if (path === "/admin/control-secrets")
        return Response.json({
          ready: true,
          automaticallyManaged: true,
          userSecrets: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_ID", "RAILWAY_API_TOKEN"],
        });
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
        const inventory = await this.driver().listProjects(this.env.RAILWAY_WORKSPACE_ID);
        return Response.json({
          projects: inventory.projects.map((p) => ({ id: p.id, name: p.name })),
          hasNextPage: inventory.hasNextPage,
        });
      }
      if (path === "/admin/upgrade-worker") {
        const upgrade = new WorkerImageUpgrade({
          store: this.store,
          sql: this.state.storage.sql,
          transaction: (fn) => this.state.storage.transactionSync(fn),
          request: railwayApi(this.env.RAILWAY_API_TOKEN),
          assertAdmin: () => {
            /* Public Worker already authenticates this privileged route. */
          },
          rpc: async (id, operation, session) =>
            nodeRpc(await this.identity(id), operation, {}, session),
        });
        const result = await upgrade.advance(String(body.workerId ?? ""), Number(body.generation), {
          image: this.env.WORKER_IMAGE,
          commit: this.env.WORKER_CORE_COMMIT,
          version: this.env.WORKER_CORE_VERSION,
        });
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify({
            event: "worker_image_upgrade",
            workerId: result.workerId,
            generation: result.generation,
            phase: result.phase,
            runtimeVersion: result.target.version,
          }),
        );
        return Response.json({
          ok: true,
          phase: result.phase,
          deploymentId: result.deploymentId,
          workerId: result.workerId,
        });
      }
      if (path === "/admin/ui") {
        const chat = Number(body.chatId),
          thread = Number(body.threadId ?? 0);
        if (!Number.isSafeInteger(chat) || !chat || !Number.isSafeInteger(thread) || thread < 0)
          throw new Error("invalid_topic");
        const command = String(body.command ?? "start");
        if (
          ![
            "start",
            "home",
            "history",
            "settings",
            "topic_settings",
            "model",
            "agent",
            "variant",
            "session",
            "context",
            "ls",
            "providers",
            "skills",
            "mcps",
            "more",
            "commands",
            "tasklist",
            "task",
            "cancel",
          ].includes(command)
        )
          throw new Error("operation_not_allowed");
        const actor = Number(
          (this.env.TELEGRAM_ALLOWED_USER_ID ?? this.env.TELEGRAM_ALLOWED_USER_IDS ?? "").split(
            ",",
          )[0],
        );
        if (!Number.isSafeInteger(actor) || !actor) throw new Error("authorization_not_configured");
        const sequence = [
          ...this.state.storage.sql.exec<{ data: string }>(
            "SELECT data FROM ui_state WHERE key='admin_ui_sequence'",
          ),
        ][0];
        const updateId = sequence ? Number(sequence.data) - 1 : -1;
        if (!Number.isSafeInteger(updateId) || updateId >= 0)
          throw new Error("invalid_ui_sequence");
        this.state.storage.sql.exec(
          "INSERT INTO ui_state VALUES('admin_ui_sequence',?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
          String(updateId),
        );
        const generation =
          this.store
            .topics()
            .find((t) => t.chatId === chat && t.threadId === thread && t.state === "ACTIVE")
            ?.generation ?? 0;
        const panel = this.ui().panelIdentity(actor, chat, thread, generation);
        const callbackAction = command === "model" ? "models" : command;
        const callback =
          body.callback === true
            ? [
                ...this.state.storage.sql.exec<{ id: string }>(
                  "SELECT id FROM ui_callbacks WHERE actor=? AND chat=? AND thread=? AND generation=? AND json_extract(data,'$.action')=? ORDER BY rowid DESC LIMIT 1",
                  actor,
                  chat,
                  thread,
                  generation,
                  callbackAction,
                ),
              ][0]
            : undefined;
        if (body.callback === true && (!callback || !panel.messageId))
          throw new Error("menu_callback_missing");
        await this.ui().handle(
          {
            update_id: updateId,
            ...(callback
              ? {
                  callback_query: {
                    id: "admin-ui-" + Math.abs(updateId),
                    from: { id: actor },
                    data: "ui:" + callback.id,
                    message: {
                      message_id: panel.messageId,
                      chat: { id: chat },
                      ...(thread > 1 ? { message_thread_id: thread } : {}),
                    },
                  },
                }
              : {
                  message: {
                    chat: { id: chat },
                    from: { id: actor },
                    ...(thread > 1 ? { message_thread_id: thread } : {}),
                    text: "/" + command,
                  },
                }),
          },
          updateId,
        );
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify({
            event: "telegram_ui_rendered",
            command,
            scope: thread > 1 ? "topic" : "general",
          }),
        );
        return Response.json({
          ok: true,
          scope: thread > 1 ? "topic" : "general",
          panel: this.ui().panelIdentity(actor, chat, thread, generation),
        });
      }
      if (path === "/admin/runtime")
        return Response.json({ schemaVersion: 6, protocol: "revision-fenced-v1" });
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
      if (path === "/admin/new-topic") {
        const job = await this.newTopic(Number(body.chatId), String(body.requestId ?? ""));
        return Response.json({
          jobId: job.jobId,
          workerId: job.workerId,
          threadId: job.threadId,
          phase: job.phase,
        });
      }
      if (path === "/admin/compact") {
        await this.enqueuePrompt(
          Number(body.chatId),
          Number(body.threadId),
          Number(body.generation),
          String(body.requestId ?? ""),
          "Context compaction",
          undefined,
          undefined,
          "session.compact",
        );
        return Response.json({ queued: true });
      }
      if (path === "/admin/run") {
        await this.enqueuePrompt(
          Number(body.chatId),
          Number(body.threadId),
          Number(body.generation),
          String(body.requestId ?? ""),
          String(body.text ?? ""),
        );
        return Response.json({ queued: true });
      }
      if (path === "/admin/run-status") {
        const requestId = String(body.requestId ?? "");
        const run = [
          ...this.state.storage.sql.exec<{ request: string; state: string }>(
            "SELECT request,state FROM runs WHERE request=? AND chat=? AND thread=?",
            requestId,
            Number(body.chatId),
            Number(body.threadId),
          ),
        ][0];
        if (!run) throw new Error("unknown_run");
        const response = [
          ...this.state.storage.sql.exec<{ state: string }>(
            "SELECT state FROM responses WHERE run=?",
            requestId,
          ),
        ][0];
        const delivery = [
          ...this.state.storage.sql.exec<{ id: string; state: string }>(
            "SELECT id,state FROM outbox WHERE json_extract(data,'$.run')=? ORDER BY id LIMIT 100",
            requestId,
          ),
        ];
        const previewRow = [
          ...this.state.storage.sql.exec<{ data: string }>(
            "SELECT data FROM ui_state WHERE key=?",
            "run-ui:" + requestId,
          ),
        ][0];
        const preview = previewRow ? JSON.parse(previewRow.data) : undefined;
        return Response.json({
          run,
          response: response ?? null,
          delivery,
          preview: preview
            ? {
                state: preview.delivery,
                messageId: preview.message,
                tools: Object.values(preview.tools ?? {}).map((t: unknown) => {
                  const v = t as { name: string; status: string };
                  return { name: v.name, status: v.status };
                }),
                visibleCharacters: (preview.last ?? "").length,
              }
            : null,
        });
      }
      if (path === "/admin/model-inspect") {
        const topic = this.store
          .topics()
          .find(
            (t) =>
              t.chatId === Number(body.chatId) &&
              t.threadId === Number(body.threadId) &&
              t.state === "ACTIVE",
          );
        if (!topic) throw new Error("topic_not_writable");
        return Response.json(
          await nodeRpc(
            await this.identity(topic.workerId),
            "model.inspect",
            { providerID: String(body.providerID ?? ""), modelID: String(body.modelID ?? "") },
            topic.sessionId,
          ),
        );
      }
      if (path === "/admin/cleanup-status")
        return Response.json(await this.driver().inspectCleanup(String(body.workerId)));
      if (path === "/admin/cancel-job") {
        const job = this.store.job(String(body.jobId));
        if (!job) throw new Error("unknown_job");
        const topic = this.store.topics().find((t) => t.workerId === job.workerId);
        if (topic) await this.deleteTopic(topic.chatId, topic.threadId);
        else {
          const current = this.store.worker(job.workerId)!;
          if (current.state === "REPLACED") return Response.json({ ok: true });
          if (!["FENCING", "DELETING"].includes(current.state))
            this.store.configureJob(job.jobId, {
              phase: "FAILED",
              error: "provisioning_cancelled",
              cleanupPhase: job.cleanupPhase ?? job.phase,
            });
          const worker = this.store.fenceWorker(job.workerId);
          if (worker.state !== "DELETING")
            this.store.transition(worker.workerId, worker.generation, "DELETING");
          await this.driver().destroy(worker.workerId, worker.generation);
          this.store.confirmDestroyed(worker.workerId, worker.generation);
        }
        return Response.json({ ok: true });
      }
      if (path === "/admin/telegram") {
        if (!this.env.TELEGRAM_BOT_TOKEN || !this.env.TELEGRAM_WEBHOOK_SECRET)
          throw new Error("telegram_not_configured");
        const telegram = new CloudTelegram(this.env.TELEGRAM_BOT_TOKEN);
        const me = await telegram.call<{
          id: number;
          username: string;
          has_topics_enabled?: boolean;
        }>("getMe", {});
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
        const chat = body.chatId
          ? await telegram.call<{ id: number; type: string; is_forum?: boolean }>("getChat", {
              chat_id: Number(body.chatId),
            })
          : undefined;
        return Response.json({
          chat: chat
            ? { id: chat.id, type: chat.type, isForum: chat.is_forum ?? false }
            : undefined,
          privateTopicsEnabled: me.has_topics_enabled ?? false,
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
        const chatId = Number(body.chatId),
          threadId = Number(body.threadId);
        if (
          !Number.isSafeInteger(chatId) ||
          chatId === 0 ||
          !Number.isSafeInteger(threadId) ||
          threadId <= 1
        )
          throw new Error("invalid_topic");
        await this.deleteTopic(chatId, threadId);
        if (
          this.store
            .jobs()
            .some(
              (job) =>
                job.chatId === chatId &&
                job.threadId === threadId &&
                this.store.worker(job.workerId)?.state !== "REPLACED",
            )
        )
          throw new Error("pending_worker_cleanup_required");
        await new CloudTelegram(this.env.TELEGRAM_BOT_TOKEN).call("deleteForumTopic", {
          chat_id: chatId,
          message_thread_id: threadId,
        });
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
        if (isWorkerImageUpgrading(this.state.storage.sql, topic.workerId))
          throw new Error("worker_upgrade_pending");
        if (
          ![
            "session.get",
            "session.messages",
            "status",
            "health",
            "models.list",
            "agents.list",
            "commands.list",
            "session.todos",
            "session.diff",
            "session.children",
            "file.list",
          ].includes(operation)
        )
          throw new Error("operation_not_allowed");
        return Response.json({
          result: await nodeRpc(
            await this.identity(topic.workerId),
            operation,
            operation === "file.list" ? { path: "." } : {},
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
        const update = { ...body } as unknown as ProtectedTelegramUpdate;
        delete update.credentialInput;
        const actor = update.message?.from?.id ?? update.callback_query?.from.id;
        const allowed = (
          this.env.TELEGRAM_ALLOWED_USER_IDS ??
          this.env.TELEGRAM_ALLOWED_USER_ID ??
          ""
        )
          .split(",")
          .map((v) => Number(v.trim()));
        if (!actor || !allowed.includes(actor)) return Response.json({ ok: true });
        const protectedUpdate = await protectTelegramCredentialUpdate(
          update,
          this.state.storage.sql,
          this.env.CREDENTIAL_MASTER_KEY,
        );
        this.state.storage.sql.exec(
          "INSERT INTO updates(id,data) VALUES(?,?) ON CONFLICT(id) DO NOTHING",
          Number(body.update_id),
          JSON.stringify(protectedUpdate),
        );
        await this.scheduleAlarm(Date.now() + 1);
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
        if (body.generation !== worker.generation) throw new Error("stale_generation");
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
        if (envelope.operation === "credential.get") {
          if (
            !topic ||
            topic.state !== "ACTIVE" ||
            envelope.sessionId !== topic.sessionId ||
            !this.store.activeRuns(topic.chatId, topic.threadId).length
          )
            throw new Error("credential_scope_rejected");
          const input = envelope.payload as {
            capability?: string;
            credentialId?: string;
            purpose?: string;
          };
          if (
            input.purpose !== "provider.request" ||
            !input.capability?.startsWith("model-provider:") ||
            !input.credentialId
          )
            throw new Error("credential_scope_rejected");
          const id = input.capability.slice("model-provider:".length);
          const data = this.store.global()?.data;
          const runtime = (
            data?.configuration as {
              runtime?: {
                provider?: Record<string, { options?: { apiKey?: string } }>;
                disabled_providers?: string[];
              };
            }
          )?.runtime;
          const references = data?.credentialReferences;
          if (
            !Array.isArray(references) ||
            !references.some(
              (r: { capability?: string; credentialId?: string; configured?: boolean }) =>
                r.capability === input.capability &&
                r.credentialId === input.credentialId &&
                r.configured === true,
            ) ||
            runtime?.disabled_providers?.includes(id) ||
            runtime?.provider?.[id]?.options?.apiKey !==
              "bot-credential-proxy:" + input.capability + ":" + input.credentialId
          )
            throw new Error("credential_scope_rejected");
          const lease = await new CloudCredentialVault(
            this.state.storage.sql,
            this.env.CREDENTIAL_MASTER_KEY,
          ).readLease(input.capability, input.credentialId);
          if (this.store.worker(worker.workerId)?.generation !== envelope.generation)
            throw new Error("stale_generation");
          return this.signed(envelope, secret, lease);
        }
        if (envelope.operation === "mutation.prepare" || envelope.operation === "mutation.commit") {
          if (!topic || topic.state !== "ACTIVE" || envelope.sessionId !== topic.sessionId)
            throw new Error("topic_not_writable");
          const payload = envelope.payload as {
            mutation: { type: string; resource: string; config: Record<string, unknown> };
            approvalId?: string;
          };
          const mutation = payload.mutation;
          if (
            !mutation ||
            typeof mutation.type !== "string" ||
            typeof mutation.resource !== "string" ||
            !mutation.config ||
            typeof mutation.config !== "object"
          )
            throw new Error("invalid_mutation");
          const configHash = await sha256(canonical(mutation));
          const global = this.store.global();
          if (!global) throw new Error("snapshot_unavailable");
          if (envelope.operation === "mutation.prepare") {
            // Validate before asking; immutable candidate is committed only after exact user approval.
            await applyGlobalConfigMutation(
              global.data,
              mutation.type,
              mutation.resource,
              mutation.config,
            );
            if (this.store.global()?.revision !== global.revision)
              throw new Error("configuration_changed");
            if (this.store.worker(worker.workerId)?.generation !== envelope.generation)
              throw new Error("stale_generation");
            const previous = [
              ...this.state.storage.sql.exec<{ id: string; data: string }>(
                "SELECT id,data FROM approvals WHERE worker=? AND generation=? AND json_extract(data,'$.sessionId')=? AND json_extract(data,'$.configHash')=? AND json_extract(data,'$.revision')=? AND state IN ('PENDING','APPROVED')",
                worker.workerId,
                envelope.generation,
                topic.sessionId,
                configHash,
                global.revision,
              ),
            ][0];
            if (previous) return this.signed(envelope, secret, JSON.parse(previous.data));
            const approvalId = crypto.randomUUID();
            const prepared = {
              status: "question-required",
              approvalId,
              configHash,
              revision: global.revision,
              workerId: worker.workerId,
              generation: envelope.generation,
              sessionId: topic.sessionId,
              expiresAt: Date.now() + 15 * 60_000,
              preview: mutation,
              question: {
                header: "Global Change",
                question:
                  "Approve " +
                  mutation.type +
                  " for " +
                  mutation.resource +
                  "? Approval: " +
                  approvalId,
                options: [
                  { label: "Approve", description: "Apply this exact Global change." },
                  { label: "Reject", description: "Leave Global unchanged." },
                ],
                multiple: false,
              },
            };
            this.state.storage.sql.exec(
              "INSERT INTO approvals VALUES(?,?,?,?,'PENDING')",
              approvalId,
              worker.workerId,
              envelope.generation,
              JSON.stringify(prepared),
            );
            return this.signed(envelope, secret, {
              ...prepared,
              questionTool: { tool: "question", arguments: { questions: [prepared.question] } },
            });
          }
          const approval = [
            ...this.state.storage.sql.exec<{ data: string; state: string }>(
              "SELECT data,state FROM approvals WHERE id=? AND worker=? AND generation=?",
              String(payload.approvalId ?? ""),
              worker.workerId,
              envelope.generation,
            ),
          ][0];
          const prepared = approval
            ? (JSON.parse(approval.data) as {
                sessionId: string;
                configHash: string;
                revision: number;
                expiresAt: number;
                receipt?: unknown;
              })
            : undefined;
          if (
            !prepared ||
            prepared.sessionId !== topic.sessionId ||
            prepared.configHash !== configHash
          )
            throw new Error("approval_mismatch");
          if (approval!.state === "COMMITTED")
            return this.signed(envelope, secret, prepared.receipt);
          if (approval!.state !== "APPROVED" || prepared.expiresAt < Date.now())
            throw new Error("approval_required");
          if (global.revision !== prepared.revision) throw new Error("configuration_changed");
          const next = await applyGlobalConfigMutation(
            global.data,
            mutation.type,
            mutation.resource,
            mutation.config,
          );
          const snapshot = { ...next, version: 1, revision: global.revision + 1 };
          const hash = await sha256(canonical(snapshot));
          if (this.store.worker(worker.workerId)?.generation !== envelope.generation)
            throw new Error("stale_generation");
          const receipt = {
            status: "committed",
            approvalId: payload.approvalId,
            revision: snapshot.revision,
            hash,
          };
          this.store.setGlobal(snapshot, hash, global.revision, {
            id: String(payload.approvalId),
            data: { ...prepared, receipt },
          });
          return this.signed(envelope, secret, receipt);
        }
        if (envelope.operation === "session.event") {
          if (!topic || topic.state !== "ACTIVE") throw new Error("topic_not_writable");
          const admitted = this.store.recordCallback(
            topic.chatId,
            topic.threadId,
            envelope.payload as Record<string, unknown>,
          );
          if (admitted) {
            new CloudRunUi(
              this.state.storage.sql,
              new CloudTelegram(this.env.TELEGRAM_BOT_TOKEN),
            ).capture(
              String((envelope.payload as Record<string, unknown>).runId),
              (envelope.payload as Record<string, unknown>).event,
            );
            new CloudTopicTitleUi(
              this.state.storage.sql,
              this.store,
              new CloudTelegram(this.env.TELEGRAM_BOT_TOKEN),
            ).capture(topic, (envelope.payload as Record<string, unknown>).event);
          }
          const event = (envelope.payload as Record<string, unknown>).event as { type?: string };
          if (admitted && ["question.asked", "permission.asked"].includes(event?.type ?? "")) {
            const key = "dispatch:" + String((envelope.payload as Record<string, unknown>).runId);
            const row = [
              ...this.state.storage.sql.exec<{ data: string }>(
                "SELECT data FROM ui_state WHERE key=?",
                key,
              ),
            ][0];
            if (row)
              this.state.storage.sql.exec(
                "UPDATE ui_state SET data=? WHERE key=?",
                JSON.stringify({ ...JSON.parse(row.data), nextPoll: 0 }),
                key,
              );
          }
          await this.scheduleAlarm(Date.now() + 1);
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
  private questionDecision(
    topic: import("./control-store.js").FleetTopic,
    requestId: string,
    questions: unknown[],
    answers: string[][],
  ): void {
    const rows = [
      ...this.state.storage.sql.exec<{ id: string; data: string }>(
        "SELECT id,data FROM approvals WHERE worker=? AND generation=? AND state='PENDING'",
        topic.workerId,
        topic.generation,
      ),
    ];
    for (const row of rows) {
      const prepared = JSON.parse(row.data) as {
        sessionId: string;
        expiresAt: number;
        question: { header: string; question: string };
      };
      if (prepared.sessionId !== topic.sessionId || prepared.expiresAt < Date.now()) continue;
      const index = questions.findIndex((q) => {
        const question = q as { header?: string; question?: string };
        return (
          question.header === prepared.question.header &&
          question.question === prepared.question.question
        );
      });
      if (index < 0) continue;
      const approved = answers[index]?.length === 1 && answers[index]?.[0] === "Approve";
      this.state.storage.sql.exec(
        "UPDATE approvals SET state=?,data=? WHERE id=? AND state='PENDING'",
        approved ? "APPROVED" : "REJECTED",
        JSON.stringify({ ...prepared, questionRequestId: requestId }),
        row.id,
      );
    }
  }
  private async saveCredential(
    update: ProtectedTelegramUpdate,
    providerId: string,
    generation: number,
  ): Promise<void> {
    const chat = update.message!.chat.id,
      actor = update.message!.from!.id,
      thread = (update.message!.message_thread_id ?? 0) > 1 ? update.message!.message_thread_id! : 0;
    const value = await readCredentialInput(update, this.env.CREDENTIAL_MASTER_KEY, {
      actor,
      chat,
      thread,
      generation,
      providerId,
    });
    const global = this.store.global();
    if (!global) throw new Error("snapshot_unavailable");
    if (providerId === "integration.github" || providerId === "integration.tailscale") {
      const id = providerId === "integration.github" ? "github" : "tailscale";
      const key = "integration-credential:" + id;
      const before = [
        ...this.state.storage.sql.exec<{ data: string }>(
          "SELECT data FROM ui_state WHERE key=?",
          key,
        ),
      ][0];
      const metadata = await new CloudIntegrationConnections(
        this.state.storage.sql,
        this.env.CREDENTIAL_MASTER_KEY,
      ).connect(id, value);
      try {
        const current = this.store.global()!;
        const integrations =
          current.data.integrations && typeof current.data.integrations === "object"
            ? current.data.integrations
            : {};
        const next = {
          ...current.data,
          integrations: { ...integrations, [id]: metadata },
          version: 1,
          revision: current.revision + 1,
        };
        const hash = await sha256(canonical(next));
        this.store.setGlobal(next, hash, current.revision);
      } catch (error) {
        const active = [
          ...this.state.storage.sql.exec<{ data: string }>(
            "SELECT data FROM ui_state WHERE key=?",
            key,
          ),
        ][0];
        if (active && JSON.parse(active.data).credentialId === metadata.credentialId) {
          if (before)
            this.state.storage.sql.exec("UPDATE ui_state SET data=? WHERE key=?", before.data, key);
          else this.state.storage.sql.exec("DELETE FROM ui_state WHERE key=?", key);
        }
        throw error;
      }
      return;
    }
    const snapshot = structuredClone(global.data);
    const configuration = snapshot.configuration as {
      runtime: { provider?: Record<string, { options?: Record<string, unknown> }> };
    };
    const provider = configuration.runtime.provider?.[providerId];
    if (!provider) throw new Error("provider_not_configured");
    const before = [
      ...this.state.storage.sql.exec<{ data: string }>(
        "SELECT data FROM ui_state WHERE key=?",
        "credential:" + providerId,
      ),
    ][0];
    const metadata = await new CloudCredentialVault(
      this.state.storage.sql,
      this.env.CREDENTIAL_MASTER_KEY,
    ).saveProvider(providerId, value);
    const references = Array.isArray(snapshot.credentialReferences)
      ? (snapshot.credentialReferences as Array<{ id?: string }>)
      : [];
    snapshot.credentialReferences = [...references.filter((r) => r.id !== metadata.id), metadata];
    provider.options = {
      ...provider.options,
      apiKey: "bot-credential-proxy:" + metadata.capability + ":" + metadata.credentialId,
    };
    const next = { ...snapshot, version: 1, revision: global.revision + 1 };
    const hash = await sha256(canonical(next));
    try {
      this.store.setGlobal(next, hash, global.revision);
    } catch (error) {
      const current = [
        ...this.state.storage.sql.exec<{ data: string }>(
          "SELECT data FROM ui_state WHERE key=?",
          "credential:" + providerId,
        ),
      ][0];
      if (current && JSON.parse(current.data).credentialId === metadata.credentialId) {
        if (before)
          this.state.storage.sql.exec(
            "UPDATE ui_state SET data=? WHERE key=?",
            before.data,
            "credential:" + providerId,
          );
        else
          this.state.storage.sql.exec(
            "DELETE FROM ui_state WHERE key=?",
            "credential:" + providerId,
          );
      }
      throw error;
    }
  }
  private topicUi(topic: import("./control-store.js").FleetTopic): CloudBotUi {
    const actor = Number(
      (this.env.TELEGRAM_ALLOWED_USER_ID ?? this.env.TELEGRAM_ALLOWED_USER_IDS ?? "").split(",")[0],
    );
    const ui = this.ui();
    return actor ? ui.forPanel(actor, topic.chatId, topic.threadId, topic.generation) : ui;
  }
  private ui(): CloudBotUi {
    const rpc = async <T>(
      topic: import("./control-store.js").FleetTopic,
      operation: string,
      payload: unknown = {},
    ): Promise<T> => {
      if (isWorkerImageUpgrading(this.state.storage.sql, topic.workerId))
        throw new Error("worker_upgrade_pending");
      if (this.store.worker(topic.workerId)?.runtimeVersion) {
        const health = await nodeRpc<{ ready: boolean }>(
          await this.identity(topic.workerId),
          "health",
          {},
          topic.sessionId,
        );
        if (!health.ready) throw new Error("worker_unavailable");
      }
      const result = await nodeRpc<T>(
        await this.identity(topic.workerId),
        operation,
        payload,
        topic.sessionId,
      );
      if (
        !this.store
          .topics()
          .some(
            (t) =>
              t.chatId === topic.chatId &&
              t.threadId === topic.threadId &&
              t.generation === topic.generation &&
              t.state === "ACTIVE",
          )
      )
        throw new Error("stale_generation");
      return result;
    };
    const global = async (
      data: Record<string, unknown>,
      expectedRevision: number,
    ): Promise<void> => {
      const snapshot = { ...data, version: 1, revision: expectedRevision + 1 };
      const hash = await sha256(canonical(snapshot));
      this.store.setGlobal(snapshot, hash, expectedRevision);
    };
    const legacyUi = new LegacyUiAdapter({
      sql: this.state.storage.sql,
      store: this.store,
      botVersion: packageJson.version,
      coreVersion: this.env.WORKER_CORE_VERSION,
      rpc,
      commitGlobal: global,
    });
    return new CloudBotUi({
      allowedUserId: this.env.TELEGRAM_ALLOWED_USER_ID,
      sql: this.state.storage.sql,
      store: this.store,
      telegram: new CloudTelegram(this.env.TELEGRAM_BOT_TOKEN),
      coreVersion: this.env.WORKER_CORE_VERSION,
      legacyUi,
      compact: (topic, request) =>
        this.enqueuePrompt(
          topic.chatId,
          topic.threadId,
          topic.generation,
          request,
          "Context compaction",
          undefined,
          undefined,
          "session.compact",
        ),
      saveCredential: (update, provider, generation) =>
        this.saveCredential(update, provider, generation),
      questionDecision: (topic, request, questions, answers) =>
        this.questionDecision(topic, request, questions, answers),
      newTopic: (chat, request) => this.newTopic(chat, request),
      deleteTopic: (chat, thread) => this.deleteTopic(chat, thread),
      cancelAllocation: (jobId) => this.cancelAllocation(jobId),
      rpc,
      global,
      ...(typeof this.state.waitUntil === "function"
        ? { waitUntil: (promise: Promise<unknown>) => this.state.waitUntil(promise) }
        : {}),
    });
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
  private async enqueuePrompt(
    chatId: number,
    threadId: number,
    generation: number,
    requestId: string,
    text: string,
    parts?: CloudPromptPart[],
    mediaModel?: string,
    operation: "run" | "session.compact" = "run",
  ): Promise<void> {
    const topic = this.store
      .topics()
      .find((t) => t.chatId === chatId && t.threadId === threadId && t.state === "ACTIVE");
    if (!topic || topic.generation !== generation) throw new Error("stale_generation");
    if (isWorkerImageUpgrading(this.state.storage.sql, topic.workerId))
      throw new Error("worker_upgrade_pending");
    if (!text || text.length > 20000) throw new Error("invalid_prompt");
    if (
      operation === "session.compact" &&
      (!supportsContextCompaction(this.env.WORKER_CORE_VERSION) ||
        !supportsContextCompaction(this.store.worker(topic.workerId)?.runtimeVersion))
    )
      throw new Error("worker_upgrade_required");
    const admittedGlobal = this.store.global();
    const selected =
      mediaModel ||
      this.ui().options(topic).model ||
      String(
        (admittedGlobal?.data.configuration as { runtime?: { model?: string } })?.runtime?.model ??
          "",
      );
    const split = selected.indexOf("/");
    if (split < 1) throw new Error("model_not_configured");
    const worker = this.store.worker(topic.workerId);
    if (worker?.runtimeVersion) {
      const health = await nodeRpc<{ ready: boolean }>(
        await this.identity(topic.workerId),
        "health",
        {},
        topic.sessionId,
      );
      if (!health.ready) throw new Error("worker_unavailable");
    }
    if (worker?.runtimeVersion && worker.revision < (admittedGlobal?.revision ?? 0)) {
      const sync = await nodeRpc<{ revision: number; hash: string; deferred?: boolean }>(
        await this.identity(topic.workerId),
        "sync-global",
        {},
        topic.sessionId,
      );
      if (
        sync.deferred ||
        sync.revision !== admittedGlobal!.revision ||
        sync.hash !== admittedGlobal!.hash
      )
        throw new Error("configuration_pending");
      this.store.saveObservation(topic.workerId, topic.generation, { revision: sync.revision });
    }
    const inspection = await nodeRpc<{ available: boolean; connected: boolean }>(
      await this.identity(topic.workerId),
      "model.inspect",
      { providerID: selected.slice(0, split), modelID: selected.slice(split + 1) },
      topic.sessionId,
    );
    if (!inspection.connected) throw new Error("provider_credential_binding_missing");
    if (!inspection.available) throw new Error("model_unavailable");
    if (isWorkerImageUpgrading(this.state.storage.sql, topic.workerId))
      throw new Error("worker_upgrade_pending");
    if (this.store.global()?.revision !== admittedGlobal?.revision)
      throw new Error("configuration_changed");
    if (
      this.ui().options(topic).promptQueueEnabled === false &&
      this.store.activeRuns(chatId, threadId).length
    )
      throw new Error("prompt_queue_disabled");
    const memories =
      (admittedGlobal?.data.defaults as { memory?: Array<{ content?: string }> })?.memory ?? [];
    const context = memories
      .slice(0, 32)
      .map((m) => m.content ?? "")
      .join("\n")
      .slice(0, 12000);
    const prompt = context
      ? "Persistent memories supplied by the user:\n" + context + "\n\nUser message:\n" + text
      : text;
    this.store.enqueueVerified(
      topic.chatId,
      topic.threadId,
      requestId,
      prompt,
      topic.generation,
      admittedGlobal!.revision,
      selected,
      operation,
    );
    if (parts)
      this.state.storage.sql.exec(
        "INSERT INTO ui_state VALUES(?,?) ON CONFLICT(key) DO NOTHING",
        "media:" + requestId,
        JSON.stringify(parts),
      );
    await this.scheduleAlarm(Date.now() + 1);
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
  private async newTopic(chatId: number, requestId: string): Promise<AllocationJob> {
    if (
      [...this.state.storage.sql.exec("SELECT key FROM ui_state WHERE key=?", "reset:" + chatId)]
        .length
    )
      throw new Error("control_reset_pending");
    if (this.env.PROVISION_ON_TOPIC_CREATE !== "true" || this.env.PROVISIONING_ENABLED !== "true")
      throw new Error("provisioning_disabled");
    await this.setup();
    let job = this.store.reserveAllocation(requestId, chatId);
    if (!job.threadId) {
      if (job.phase === "TOPIC_CREATING") throw new Error("topic_creation_reconciliation_required");
      const topicTitle = this.store.reserveTopicTitle(job.jobId);
      this.store.configureJob(job.jobId, { phase: "TOPIC_CREATING" });
      let created: { message_thread_id: number };
      try {
        created = await new CloudTelegram(this.env.TELEGRAM_BOT_TOKEN).call("createForumTopic", {
          chat_id: chatId,
          name: topicTitle,
        });
      } catch (error) {
        if (error instanceof TelegramDeliveryError && error.category === "rate_limited")
          this.store.configureJob(job.jobId, { phase: "PROVISIONING" });
        if (error instanceof TelegramDeliveryError && error.category === "rejected") {
          this.store.configureJob(job.jobId, {
            phase: "FAILED",
            error: "telegram_topic_creation_rejected",
          });
          this.store.transition(job.workerId, job.generation, "DELETING");
          this.store.confirmDestroyed(job.workerId, job.generation);
        }
        throw error;
      }
      job = this.store.configureJob(job.jobId, {
        threadId: created.message_thread_id,
        phase: "PROVISIONING",
      });
      this.store.saveObservation(job.workerId, job.generation, {
        chatId,
        threadId: created.message_thread_id,
      });
    }
    await this.scheduleAlarm(Date.now() + 15_000);
    await this.env.JOBS.send({ jobId: job.jobId });
    return job;
  }
  private async advance(jobId: string): Promise<void> {
    if (this.env.PROVISIONING_ENABLED !== "true") throw new Error("provisioning_disabled");
    const job = this.store.job(jobId);
    if (!job) throw new Error("unknown_job");
    if (
      [
        ...this.state.storage.sql.exec(
          "SELECT key FROM ui_state WHERE key=?",
          "reset:" + job.chatId,
        ),
      ].length
    )
      throw new Error("control_reset_pending");
    if (job.phase === "BOUND") {
      const topic = this.store
        .topics()
        .find((t) => t.workerId === job.workerId && t.state === "ACTIVE");
      if (topic) await this.topicUi(topic).ready(topic);
      return;
    }
    if (job.error) throw new Error(job.error);
    if (job.createdAt && Date.now() - job.createdAt > 20 * 60_000) {
      this.store.configureJob(jobId, {
        phase: "RECONCILIATION_REQUIRED",
        error: "worker_bootstrap_timeout",
        cleanupPhase: job.phase,
      });
      this.store.transition(job.workerId, job.generation, "UNHEALTHY");
      throw new Error("worker_bootstrap_timeout");
    }
    if (!job.threadId) throw new Error("topic_pending");
    const owner = crypto.randomUUID();
    if (!this.store.acquireLease("railway-provisioning", owner, Date.now(), 180_000))
      throw new Error("provisioning_pending");
    const guard = () => {
      if (
        [
          ...this.state.storage.sql.exec(
            "SELECT key FROM ui_state WHERE key=?",
            "reset:" + job.chatId,
          ),
        ].length
      )
        throw new Error("control_reset_pending");
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
        await this.scheduleAlarm(Date.now() + 15_000);
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
        await this.scheduleAlarm(Date.now() + 15_000);
        return;
      }
      guard();
      if (!health.ready) {
        await this.scheduleAlarm(Date.now() + 15_000);
        return;
      }
      if (
        health.runtime?.telegramCoreCommit !== this.env.WORKER_CORE_COMMIT ||
        health.runtime?.telegramCoreVersion !== this.env.WORKER_CORE_VERSION
      )
        throw new Error("worker_image_mismatch");
      guard();
      const observed = await this.driver(guard).inspectDeployment(jobId);
      if (observed.status !== "SUCCESS") {
        await this.scheduleAlarm(Date.now() + 15_000);
        return;
      }
      const session = await nodeRpc<{ sessionId: string }>(identity, "session.create", {});
      guard();
      this.store.saveObservation(worker.workerId, job.generation, {
        image: observed.image,
        deploymentId: observed.deploymentId,
        runtimeCommit: health.runtime.telegramCoreCommit,
        runtimeVersion: health.runtime.telegramCoreVersion,
        lastHealthAt: Date.now(),
      });
      this.store.ready(worker.workerId, job.generation, worker.credential!);
      const bound = this.store.bindTopic(jobId, job.threadId, session.sessionId);
      if (job.topicTitle) {
        const key = `topic:${bound.chatId}:${bound.threadId}:${bound.generation}`;
        this.state.storage.sql.exec(
          "INSERT INTO ui_state(key,data) VALUES(?,?) ON CONFLICT(key) DO NOTHING",
          key,
          JSON.stringify({ title: job.topicTitle, titleSource: "auto" }),
        );
      }
      await this.topicUi(bound).ready(bound);
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          event: "worker_bound",
          workerId: job.workerId,
          generation: job.generation,
        }),
      );
    } finally {
      this.store.releaseLease("railway-provisioning", owner);
    }
  }
  private async cancelAllocation(jobId: string): Promise<void> {
    const job = this.store.job(jobId);
    if (!job) throw new Error("unknown_job");
    const topic = this.store.topics().find((t) => t.workerId === job.workerId);
    if (topic) {
      await this.deleteTopic(topic.chatId, topic.threadId);
      return;
    }
    const current = this.store.worker(job.workerId)!;
    if (current.state === "REPLACED") return;
    this.store.configureJob(job.jobId, {
      phase: "FAILED",
      error: "provisioning_cancelled",
      cleanupPhase: job.cleanupPhase ?? job.phase,
    });
    const worker = this.store.fenceWorker(job.workerId);
    if (worker.state !== "DELETING")
      this.store.transition(worker.workerId, worker.generation, "DELETING");
    await this.driver().destroy(worker.workerId, worker.generation);
    this.store.confirmDestroyed(worker.workerId, worker.generation);
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
    await this.initializeSecrets();
    const pending = [...this.state.storage.sql.exec<{ data: string }>("SELECT data FROM jobs")]
      .map((r) => JSON.parse(r.data) as AllocationJob)
      .filter(
        (j) =>
          [
            "PROVISIONING",
            "VOLUME_CREATING",
            "VOLUME_CREATED",
            "VOLUME_ATTACHING",
            "BINDING",
            "DEPLOYING",
            "DEPLOY_SUBMITTED",
          ].includes(j.phase) && j.threadId !== undefined,
      );
    for (const job of pending) {
      try {
        await this.advance(job.jobId);
      } catch {
        await this.scheduleAlarm(Date.now() + 30_000);
      }
    }

    this.clearInactiveTyping();
    for (const topic of this.store.topics().filter((t) => t.state === "ACTIVE")) {
      if (isWorkerImageUpgrading(this.state.storage.sql, topic.workerId)) continue;
      const run =
        this.store.activeRuns(topic.chatId, topic.threadId)[0] ??
        this.store.startNext(topic.chatId, topic.threadId);
      if (!run || this.store.worker(topic.workerId)?.state === "UNHEALTHY") continue;
      await this.refreshTyping(topic, run.requestId);
      try {
        const text = [
          ...this.state.storage.sql.exec<{ text: string }>(
            "SELECT p.text FROM response_parts p LEFT JOIN message_roles r ON r.run=p.run AND r.message=p.message WHERE p.run=? AND (p.message IS NULL OR r.role='assistant') ORDER BY p.rowid",
            run.requestId,
          ),
        ]
          .map((p) => p.text)
          .join("\n");
        const previewDue = await new CloudRunUi(
          this.state.storage.sql,
          new CloudTelegram(this.env.TELEGRAM_BOT_TOKEN),
        ).progress(topic, run.requestId, text, this.ui().options(topic));
        if (previewDue !== undefined) await this.scheduleAlarm(previewDue);
      } catch {
        /* Execution continues; durable delivery receipt prevents duplicate sends. */
      }
      const dispatchKey = "dispatch:" + run.requestId;
      const dispatchRow = [
        ...this.state.storage.sql.exec<{ data: string }>(
          "SELECT data FROM ui_state WHERE key=?",
          dispatchKey,
        ),
      ][0];
      const dispatch = dispatchRow
        ? (JSON.parse(dispatchRow.data) as {
            accepted?: boolean;
            nextPoll?: number;
            generation?: number;
            sessionId?: string;
            workerId?: string;
          })
        : undefined;
      const accepted =
        dispatch?.accepted &&
        dispatch.generation === topic.generation &&
        dispatch.sessionId === topic.sessionId &&
        dispatch.workerId === topic.workerId;
      if (accepted && (dispatch.nextPoll ?? 0) > Date.now()) {
        await this.scheduleAlarm(dispatch.nextPoll!);
        continue;
      }
      const owner = crypto.randomUUID(),
        lease = "dispatch:" + run.requestId;
      if (!this.store.acquireLease(lease, owner, Date.now(), 60_000)) continue;
      try {
        const pin = this.store.runPin(run.requestId);
        if (
          pin &&
          (pin.generation !== topic.generation ||
            (!pin.dispatched && pin.revision !== this.store.global()?.revision))
        ) {
          this.store.failRun(
            topic.chatId,
            topic.threadId,
            run.requestId,
            "Configuration changed; send the prompt again.",
          );
          continue;
        }
        this.store.markRunDispatched(run.requestId);
        const operation = this.store.runOperation(run.requestId);
        if (
          operation === "session.compact" &&
          !supportsContextCompaction(this.store.worker(topic.workerId)?.runtimeVersion)
        )
          throw new Error("worker_upgrade_required");
        const reply = accepted
          ? { accepted: true }
          : await nodeRpc<{ accepted: boolean }>(
              await this.identity(topic.workerId),
              operation,
              {
                runId: run.requestId,
                ...(operation === "run" ? { text: run.prompt } : {}),
                ...(operation === "run"
                  ? (() => {
                      const row = [
                        ...this.state.storage.sql.exec<{ data: string }>(
                          "SELECT data FROM ui_state WHERE key=?",
                          "media:" + run.requestId,
                        ),
                      ][0];
                      return row
                        ? {
                            parts: [
                              { type: "text", text: run.prompt },
                              ...JSON.parse(row.data).filter(
                                (p: CloudPromptPart) => p.type === "file",
                              ),
                            ],
                          }
                        : {};
                    })()
                  : {}),
                events: true,
                ...(operation === "run" && this.ui().options(topic).agent
                  ? { agent: this.ui().options(topic).agent }
                  : {}),
                ...(operation === "run" && this.ui().options(topic).variant
                  ? { variant: this.ui().options(topic).variant }
                  : {}),
                ...(pin
                  ? {
                      expectedRevision: pin.revision,
                      model: {
                        providerID: pin.model.slice(0, pin.model.indexOf("/")),
                        modelID: pin.model.slice(pin.model.indexOf("/") + 1),
                      },
                    }
                  : {}),
              },
              topic.sessionId,
            );

        const status = await nodeRpc<{ state: string }>(
          await this.identity(topic.workerId),
          "callback.status",
          { runId: run.requestId },
          topic.sessionId,
        );
        const actor = Number(
          (this.env.TELEGRAM_ALLOWED_USER_IDS ?? this.env.TELEGRAM_ALLOWED_USER_ID ?? "").split(
            ",",
          )[0],
        );
        if (status.state === "ACCEPTED")
          this.state.storage.sql.exec(
            "INSERT INTO ui_state(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
            dispatchKey,
            JSON.stringify({
              accepted: true,
              nextPoll: Date.now() + 15000,
              generation: topic.generation,
              sessionId: topic.sessionId,
              workerId: topic.workerId,
            }),
          );
        if (actor && status.state === "ACCEPTED") {
          await this.topicUi(topic).runKeyboard(topic, run.requestId, true);
          await this.ui().interactions(topic, actor);
        }
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
          await this.scheduleAlarm(Date.now() + 30_000);
      } catch (error) {
        if (error instanceof Error && error.message === "worker_operation_rejected") {
          try {
            const active = await nodeRpc(
              await this.identity(topic.workerId),
              "status",
              {},
              topic.sessionId,
            );
            if (!active)
              this.store.failRun(
                topic.chatId,
                topic.threadId,
                run.requestId,
                en["bot.prompt_send_error"],
              );
          } catch {
            // Preserve ownership when execution inactivity cannot be authenticated.
          }
        }
        this.store.releaseLease(lease, owner);
        await this.scheduleAlarm(Date.now() + 15_000);
      }
    }
    for (const response of this.store.completedResponses()) {
      const topic = this.store
        .topics()
        .find(
          (t) =>
            t.chatId === response.chat && t.threadId === response.thread && t.state === "ACTIVE",
        );
      const pin = this.store.runPin(response.run);
      if (!topic || (pin && pin.generation !== topic.generation)) {
        this.store.responseDelivered(response.run, "FENCED");
        continue;
      }
      const preferences = this.ui().options(topic);
      const text =
        response.text +
        (preferences.showAssistantRunFooter
          ? "\n\n— " +
            (pin?.model ?? "OpenCode") +
            " · Core " +
            this.store.worker(topic.workerId)?.runtimeVersion
          : "");
      const parts =
          preferences.messageFormatMode === "raw"
            ? Array.from(text)
                .reduce<string[]>((chunks, char) => {
                  if (!chunks.length || chunks[chunks.length - 1]!.length + char.length > 3900)
                    chunks.push("");
                  chunks[chunks.length - 1] += char;
                  return chunks;
                }, [])
                .map((fallbackText) => ({ fallbackText, blocks: [], source: "plain" as const }))
            : renderTelegramParts(text),
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
          if (
            index === 0 &&
            (await new CloudRunUi(this.state.storage.sql, telegram).finish(
              topic,
              response.run,
              parts[index]!.fallbackText,
              preferences.messageFormatMode === "raw" ? undefined : parts[index]!,
            ))
          ) {
            // Finalize the already visible preview rather than duplicating the reply.
          } else if (preferences.messageFormatMode === "raw") {
            await telegram.call("sendMessage", {
              chat_id: response.chat,
              message_thread_id: response.thread,
              text: parts[index]!.fallbackText,
            });
          } else await telegram.sendPart(response.chat, response.thread, parts[index]!);
          this.state.storage.sql.exec("UPDATE outbox SET state='DELIVERED' WHERE id=?", id);
        } catch (error) {
          const state =
            error instanceof TelegramDeliveryError && error.category === "rate_limited"
              ? "PENDING"
              : "RECONCILIATION_REQUIRED";
          this.state.storage.sql.exec("UPDATE outbox SET state=? WHERE id=?", state, id);
          if (state === "PENDING") await this.scheduleAlarm(Date.now() + 30_000);
          else this.store.responseDelivered(response.run, state);
          complete = false;
          break;
        }
      }
      const runCompleted =
        [
          ...this.state.storage.sql.exec<{ state: string }>(
            "SELECT state FROM runs WHERE request=?",
            response.run,
          ),
        ][0]?.state === "COMPLETED";
      if (complete && runCompleted && preferences.sendDiffFileAttachments) {
        const id = response.run + ":diff";
        const receipt = [
          ...this.state.storage.sql.exec<{ state: string }>(
            "SELECT state FROM outbox WHERE id=?",
            id,
          ),
        ][0];
        if (!receipt || receipt.state === "PENDING") {
          try {
            const files = await this.ui().rpcDiff(topic);
            const patch = Array.isArray(files)
              ? files
                  .slice(0, 32)
                  .map((file) => {
                    const value = file as { patch?: string };
                    return typeof value.patch === "string" ? value.patch : "";
                  })
                  .join("\n")
                  .slice(0, 262144)
              : "";
            if (patch) {
              this.state.storage.sql.exec(
                "INSERT INTO outbox VALUES(?,?,'SENDING') ON CONFLICT(id) DO UPDATE SET state='SENDING'",
                id,
                JSON.stringify({ run: response.run, artifact: "diff" }),
              );
              await telegram.document(topic.chatId, topic.threadId, "changes.diff", patch);
            }
            this.state.storage.sql.exec(
              "INSERT INTO outbox VALUES(?,?,'DELIVERED') ON CONFLICT(id) DO UPDATE SET state='DELIVERED'",
              id,
              JSON.stringify({ run: response.run, artifact: "diff" }),
            );
          } catch (error) {
            if (error instanceof TelegramDeliveryError) {
              const state =
                error.category === "rate_limited" ? "PENDING" : "RECONCILIATION_REQUIRED";
              this.state.storage.sql.exec(
                "INSERT INTO outbox VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state",
                id,
                JSON.stringify({ run: response.run, artifact: "diff" }),
                state,
              );
              if (state === "PENDING") {
                complete = false;
                await this.scheduleAlarm(Date.now() + 30000);
              }
            }
          }
        }
      }
      if (complete) {
        if (runCompleted && this.store.worker(topic.workerId)?.runtimeVersion) {
          try {
            const info = await nodeRpc(
              await this.identity(topic.workerId),
              "session.get",
              {},
              topic.sessionId,
            );
            new CloudTopicTitleUi(this.state.storage.sql, this.store, telegram).capture(topic, {
              type: "session.updated",
              properties: { info },
            });
          } catch {
            /* Accepted signed title events remain the primary path. */
          }
        }
        this.store.responseDelivered(response.run);
        this.state.storage.sql.exec("DELETE FROM ui_state WHERE key=?", `typing:${response.run}`);
        await this.topicUi(topic).runKeyboard(topic, response.run, false);
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify({
            event: "run_response_delivered",
            workerId: topic.workerId,
            generation: topic.generation,
            runId: response.run,
          }),
        );
        await this.scheduleAlarm(Date.now() + 1);
      }
    }
    const titles = new CloudTopicTitleUi(
      this.state.storage.sql,
      this.store,
      new CloudTelegram(this.env.TELEGRAM_BOT_TOKEN),
    );
    await titles.flush();
    const nextTitle = titles.nextDue();
    if (nextTitle !== undefined) await this.scheduleAlarm(nextTitle);
    const taskUi = new CloudTaskUi({
      sql: this.state.storage.sql,
      store: this.store,
      actorId: 0,
      chatId: 0,
      threadId: 0,
      generation: 0,
      button: () => {
        throw new Error("alarm_has_no_ui");
      },
      prompt: async () => {},
      notice: async () => {},
      menu: async () => {},
    });
    const nextTask = await taskUi.tick((topic, request, text) =>
      this.enqueuePrompt(topic.chatId, topic.threadId, topic.generation, request, text),
    );
    if (nextTask !== undefined) await this.scheduleAlarm(Math.min(nextTask, Date.now() + 60_000));
    const rows = [
      ...this.state.storage.sql.exec<{ id: number; data: string }>(
        "SELECT id,data FROM updates WHERE state='PENDING' ORDER BY id LIMIT 20",
      ),
    ];
    for (const row of rows) {
      const update = JSON.parse(row.data) as TelegramUpdate;
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
      const telegram = new CloudTelegram(this.env.TELEGRAM_BOT_TOKEN);
      try {
        const handled = await this.ui().handle(update, row.id);
        if (
          !handled &&
          chatId &&
          update.message &&
          (update.message.text ||
            update.message.photo ||
            update.message.document ||
            update.message.voice ||
            update.message.audio) &&
          update.message.message_thread_id
        ) {
          const threadId = update.message.message_thread_id;
          if (
            !this.store
              .topics()
              .some(
                (t) => t.chatId === chatId && t.threadId === threadId && t.state === "ACTIVE",
              ) &&
            this.store.pendingTopic(chatId, threadId)
          ) {
            await this.scheduleAlarm(Date.now() + 15_000);
            continue;
          }
          const topic = this.store
            .topics()
            .find((t) => t.chatId === chatId && t.threadId === threadId && t.state === "ACTIVE");
          if (!topic) throw new Error("topic_not_writable");
          await this.enqueuePrompt(
            chatId,
            threadId,
            topic.generation,
            "telegram_" + row.id,
            update.message.text ?? update.message.caption ?? "Please inspect the attached file.",
            update.message.photo ||
              update.message.document ||
              update.message.voice ||
              update.message.audio
              ? await telegramMediaParts(telegram, update.message)
              : undefined,
            update.message.photo
              ? this.ui().options(topic).imageModel
              : update.message.voice || update.message.audio
                ? this.ui().options(topic).voiceModel
                : undefined,
          );
        }
        this.state.storage.sql.exec("UPDATE updates SET state='DISPATCHED' WHERE id=?", row.id);
      } catch (error) {
        // Ambiguous Topic creation must not be retried into a second Telegram Topic.
        if (
          (error instanceof TelegramDeliveryError && error.category === "rate_limited") ||
          (error instanceof Error &&
            [
              "volume_cleanup_pending",
              "cleanup_pending",
              "pending_worker_cleanup_required",
              "worker_upgrade_pending",
              "configuration_pending",
              "configuration_changed",
              "worker_unavailable",
            ].includes(error.message))
        ) {
          await this.scheduleAlarm(Date.now() + 30_000);
          continue;
        }
        this.state.storage.sql.exec("UPDATE updates SET state='FAILED' WHERE id=?", row.id);
        if (chatId)
          try {
            const messageThread =
              update.message?.message_thread_id ??
              update.callback_query?.message?.message_thread_id ??
              0;
            const thread = messageThread > 1 ? messageThread : 0;
            const generation =
              this.store
                .topics()
                .find((t) => t.chatId === chatId && t.threadId === thread && t.state === "ACTIVE")
                ?.generation ?? 0;
            await this.ui()
              .forPanel(actor, chatId, thread, generation)
              .showError(
                error instanceof Error &&
                  ["capacity_exhausted", "project_capacity_exhausted"].includes(error.message)
                  ? en["new.capacity_exhausted"]
                  : error instanceof Error && error.message === "execution_active"
                    ? "Stop the current run before changing this setting."
                    : error instanceof Error && error.message === "interaction_expired"
                      ? "This question or permission request has expired."
                      : error instanceof Error && error.message === "model_unavailable"
                        ? "This model is unavailable. Select a connected provider/model."
                        : error instanceof Error &&
                            error.message === "provider_credential_binding_missing"
                          ? "Connect this provider in Settings → Providers before using the model."
                          : error instanceof Error && error.message === "stale_generation"
                            ? "This Topic or menu has expired. Open the current menu again."
                            : error instanceof Error && error.message === "media_too_large"
                              ? "This attachment is too large for the current transport (256 KiB). Send a smaller file."
                              : "The operation could not be completed. Reopen its menu and try again.",
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
      await this.scheduleAlarm(Date.now() + 30_000);
  }
}
