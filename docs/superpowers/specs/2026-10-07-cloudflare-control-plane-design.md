# Cloudflare Control Plane Migration Design

Date: 2026-10-07
Status: Proposed for implementation after user review

## Intent

Move the Telegram/control-plane role off Railway and onto Cloudflare while keeping Railway as disposable, topic-dedicated execution capacity. The user-visible rule is simple: one writable AI Topic owns one dedicated Railway Worker, and `New Chat` provisions capacity lazily when no reusable Worker exists.

The migration must preserve the existing topic isolation, generation fencing, signed Worker transport, global configuration revisioning, Telegram UX, Core ownership boundaries, and fail-closed behavior. The current Railway Bot remains the production fallback until one real Telegram prompt completes end-to-end through the Cloudflare control plane and a Railway Worker.

## Current state that must be replaced, not duplicated

The existing repository already contains most of the distributed building blocks:

- `src/control-plane/*` owns global state, node bindings, node protocol, dispatch, control and lifecycle glue.
- `src/infrastructure/railway-client.ts` wraps Railway GraphQL with fixed error categories and keeps the Railway credential out of the application child environment.
- `src/infrastructure/node-provisioner.ts` creates Worker services, dedicated 500 MB volumes, public Worker domains, identity variables, resource limits, serverless sleep and exact Core source deployment.
- `src/infrastructure/worker-pools.ts` is intentionally hard-coded to two existing projects with two slots each.
- `src/infrastructure/control-location.ts` and the `NodeProvisioner` constructor currently require the Control endpoint to be a `*.up.railway.app` HTTPS origin.
- Worker creation currently connects each service to the Core repository and exact commit, causing a source build per new Worker.
- `opencode-telegram-core/Dockerfile.worker` already contains the required Topic execution toolchain, browser runtime, process-governed OpenCode binary and headless Worker agent.

The Cloudflare migration must reuse these contracts where correct instead of introducing a second Node protocol or a second provisioning implementation.

## Target architecture

```text
Telegram
   |
   | HTTPS webhook
   v
Cloudflare Worker
   |
   +-- Telegram authentication / UI / callbacks
   +-- short request routing
   |
   v
ControlPlane Durable Object (SQLite)
   |
   +-- canonical topic registry
   +-- canonical node registry
   +-- Railway backend/project registry
   +-- generation fences
   +-- global revision / approvals
   +-- provisioning journal
   |
   +--> Cloudflare Queue --> provisioning consumer --> Railway Public API
   |
   +--> signed Node RPC --------------------------------------+
                                                             |
                                                     Railway Worker
                                                     OpenCode/Core/tools
```

Cloudflare is the durable control authority. Railway is execution capacity only.

## Core invariants

1. `1 writable AI Topic = 1 dedicated Worker`.
2. General/ALL never owns a Worker and never executes models or tools.
3. Topic identity remains fenced by `chatId + threadId + sessionId + normalizedDirectory + generation` wherever those fields are applicable.
4. A stale Worker generation cannot emit Telegram output, mutate canonical state, request credentials, or accept a new turn.
5. No shared mutable session/tool/process/workspace state is allowed across Topics.
6. No local execution fallback is allowed if a bound Worker is unavailable; work queues or fails closed.
7. A Telegram Topic is committed only after a Worker reservation is valid and the Worker is ready to bind.
8. Worker capacity is derived from actual provisionable/verified capacity, not a hard-coded Topic maximum.
9. Railway credentials never enter a model-visible Worker environment.
10. Production Railway Control/Bot is not removed until the Cloudflare path passes a real end-to-end Telegram canary.

## Cloudflare components

### Edge Worker

The Worker exposes narrow routes:

- `POST /telegram/webhook`
- `POST /nodes/bootstrap`
- `POST /nodes/events`
- `GET /health`

Telegram requests are authenticated with the configured Telegram webhook secret. Node routes use the existing signed transport concepts plus one-time bootstrap semantics. Long OpenCode execution never remains attached to the original Telegram request.

### ControlPlane Durable Object

Use a SQLite-backed Durable Object as the single coordination authority for the current single-user product. SQLite is chosen because Cloudflare recommends SQLite-backed Durable Objects for new namespaces and it provides transactional, strongly consistent per-object storage.

Initial tables:

- `topics`
- `nodes`
- `railway_backends`
- `railway_projects`
- `provision_jobs`
- `global_state`
- `approval_receipts`
- `bootstrap_tokens`
- `event_dedup`

All allocation and binding transitions happen through the Durable Object so simultaneous `New Chat` requests cannot claim the same Worker or exceed configured capacity.

### Queue

Provisioning and replacement are asynchronous queue jobs. Telegram webhook handling reserves the intent, sends a progress response, enqueues work and returns. The queue consumer may call Railway, wait for deployment state, retry bounded reconciliation steps and then commit the Worker binding through the Durable Object.

## Worker lifecycle

Canonical states:

```text
PROVISIONING
  -> READY_UNBOUND
  -> BOUND_IDLE
  -> BOUND_ACTIVE
  -> BOUND_IDLE
  -> SLEEPING
```

Deletion/unbinding:

```text
BOUND_* -> FENCING -> CLEANING -> READY_UNBOUND -> SLEEPING
```

Failure:

```text
BOUND_* -> UNHEALTHY -> RECOVERING -> READY
                         or
                       REPLACED
```

A deleted Topic does not automatically delete its Railway service. The Worker is generation-fenced, Topic-private state is cleaned, and the Worker becomes reusable. Physical service/volume deletion happens only when configured capacity is reduced, the Worker is irrecoverable, or an explicit retirement policy applies.

## `New Chat` allocation flow

`New Chat` is the provisioning trigger.

1. Durable Object reserves a Topic intent.
2. If a verified `READY_UNBOUND` Worker exists, reserve it atomically.
3. Otherwise select a Railway backend and project with remaining capacity.
4. If no current project can accept another Worker, create the next managed project if backend policy permits it.
5. Provision exactly one Worker.
6. Verify Worker health, identity, generation and runtime profile.
7. Create the Telegram Topic.
8. Atomically commit `Topic <-> Worker` ownership.
9. Mark the Topic ready and activate its Topic keyboard/UI.

If any pre-commit step fails, the Telegram Topic is not left as a writable orphan. The reservation is retained as failed/retryable or rolled back according to the failure category.

## Capacity and Railway project sharding

Remove `maximum=4` and the fixed two-project/two-slot shape.

Introduce backend policy:

```text
RailwayBackendPolicy {
  desiredMaxWorkers
  maxWorkersPerProject
  preferredRegion
  workerMemoryGB
  workerVcpus
}
```

`desiredMaxWorkers` is permission to provision up to that count, not an instruction to pre-create the fleet. Provisioning remains lazy.

Project selection is deterministic:

1. Reuse a managed project with a free Worker slot.
2. Otherwise create the next managed project if total desired capacity is not exhausted and Railway permits it.
3. Otherwise reject `New Chat` with a user-facing capacity/quota message.

The default policy may use five Workers per project where Railway account/project limits allow it, but the implementation must treat Railway's live API response as authoritative and must classify resource-limit failures rather than assuming a fixed plan limit.

## Railway backend registry

The Control Plane must not assume one Railway workspace/token.

Each backend record stores non-secret metadata plus an encrypted credential reference:

```text
backendId
workspaceId
credentialCiphertext / credentialRef
enabled
policy
health
lastVerifiedAt
```

Backend selection is capacity- and health-aware. Multiple legitimate Railway backends may coexist. The design must not contain logic whose purpose is to evade provider account/trial restrictions.

## Prebuilt Worker image

Real-time provisioning cannot depend on a full Core source build per `New Chat`.

The Worker runtime must become an immutable prebuilt image whose identity includes:

- Core release/version
- Core source commit
- OpenCode upstream version/commit
- image digest
- worker protocol version

Provisioning attaches the exact image digest to a Railway service instead of attaching the Core repository and `Dockerfile.worker` for every new service.

No new GitHub Actions workflow is introduced for this migration. Image publication must use the project's existing release/build mechanism or an explicitly invoked release step. Until a published image exists, the source-build path remains available only as a migration fallback and is not considered the final real-time provisioning path.

## Bootstrap and Worker identity

The final Worker bootstrap surface should converge toward:

```text
CONTROL_PLANE_URL
BOOTSTRAP_TOKEN
```

The bootstrap token is one-time, short-lived, scoped to the expected Railway resource and consumed on first successful join. The Control Plane returns durable node identity, current generation and desired global revision. Long-term Worker identity is persisted on the Worker's dedicated volume and used by the signed Node protocol.

During migration, the existing `NODE_ID`, `NODE_GENERATION`, `NODE_SHARED_SECRET`, `CONTROL_PLANE_URL` contract may remain as a compatibility step, but it must not become a second permanent identity scheme.

## Node transport changes

The current code rejects any Control URL that is not `*.up.railway.app`. That ownership rule must be replaced with an explicit configured Cloudflare Control origin and strict URL validation.

Required properties:

- HTTPS only.
- Exact configured origin; no redirects.
- timestamp + nonce + body hash + HMAC/signature.
- replay rejection.
- node ID and generation in the authenticated envelope.
- topic/session fence checks before dispatch and immediately before Telegram output.
- idempotency keys for Node events so retries cannot duplicate Telegram side effects.

The Worker public API remains narrow. Raw OpenCode is never exposed publicly.

## Prompt execution flow

1. Telegram webhook authenticates and resolves the Topic.
2. Durable Object validates Topic/Worker binding and generation.
3. If the Worker is sleeping, the user prompt is persisted in the Topic queue and the signed Worker request wakes Railway.
4. Worker verifies global revision before execution.
5. Worker executes the Core/OpenCode turn.
6. Worker emits signed events (`run.started`, text/tool/question events, `run.completed` / failure).
7. Cloudflare validates generation and deduplicates events before Telegram send/edit operations.
8. Completion advances the per-Topic queue.

No prompt is silently rerouted to another Topic Worker or to a local Control runtime.

## Global state and credentials

Cloudflare becomes authoritative for global application revision/state. Workers receive snapshots by revision/hash and must activate newer state atomically before a turn that requires it.

Railway tokens and other control credentials are encrypted at rest. A Cloudflare secret provides root encryption/key material; plaintext credentials are decrypted only inside the control execution boundary and are never copied into Worker snapshots or logs.

Worker credential access remains lease/proxy based where already supported. Full credential stores are not replicated to Workers.

## Recovery

Canonical Control state must survive Cloudflare Worker eviction/restart through Durable Object storage. Worker execution state remains on the dedicated Railway volume.

Recovery rules:

- sleeping Worker: wake and verify before dispatch;
- transient Worker failure: bounded retry/reconciliation without changing Topic ownership;
- stale or foreign generation: reject and fence;
- unrecoverable Worker/service: fence old generation, provision replacement, restore supported checkpoint state, rebind the existing Telegram Topic;
- backend outage: preserve Topic binding state as unavailable/recovering; do not fall back to shared/local execution.

R2 checkpointing is a later recovery enhancement, not a prerequisite for the first Cloudflare canary. The first implementation may rely on Worker volumes while making checkpoint interfaces explicit.

## Migration phases

### Phase 1 - Provisioning boundary and image contract

- Extract Railway provisioning behind a provider/driver interface that has no dependency on the Railway-hosted Bot process.
- Replace fixed `[WorkerPool, WorkerPool]`/capacity-2 assumptions with backend/project inventory abstractions.
- Add an image-based Worker source contract while retaining the exact-commit source path as a temporary migration fallback.
- Remove `maximum four AI nodes` from the infrastructure layer; admission comes from backend policy and verified capacity.
- Add regression tests for lazy allocation, project rollover, quota rejection and reusable unbound Workers.

### Phase 2 - Cloudflare skeleton

- Add the Cloudflare Worker package/app inside this repository initially so protocol types and tests remain shared.
- Add `wrangler` configuration, webhook handler, SQLite Durable Object schema and queue consumer.
- Reuse/extract pure protocol/state types from current `src/control-plane` rather than copy-pasting them.
- No production Telegram webhook cutover yet.

### Phase 3 - Node bootstrap and signed transport

- Allow the configured Cloudflare HTTPS origin.
- Implement one-time bootstrap and Node event ingress.
- Preserve replay and generation fencing.
- Validate one existing Worker against the Cloudflare control endpoint without moving user traffic.

### Phase 4 - Real `New Chat` canary

- Route one new Telegram Topic through Cloudflare.
- Lazily allocate/reuse one Railway Worker.
- Execute one real Telegram prompt end-to-end.
- Verify Telegram streaming, tool events, completion, Worker sleep and wake.

### Phase 5 - Application state/UI migration

Move Telegram control-only concerns to Cloudflare in bounded slices: Settings, Model Center, Questions/approvals, Actions/Extensions, integrations and global configuration. Core execution behavior stays in Core/Workers.

### Phase 6 - Full cutover and Railway Control retirement

- Route all writable Topics through remote Workers.
- Prove no local OpenCode turn occurs on Control.
- Disable local OpenCode/browser/toolchain from the Bot.
- Move Telegram webhook ownership to Cloudflare.
- Only then remove the Railway Bot/Control service.

### Phase 7 - Multi-backend and recovery hardening

- Add additional Railway backends.
- Add project auto-creation/rollover across backend policies.
- Add checkpoint/restore and cross-backend replacement qualification.

## Testing strategy

Use TDD for each migration slice.

Required test families:

- allocation state-machine tests;
- simultaneous `New Chat` race tests;
- project rollover and resource-limit classification;
- reuse of `READY_UNBOUND` Worker before provisioning;
- generation/replay/foreign-topic rejection;
- bootstrap token one-time consumption;
- Cloudflare event deduplication;
- sleeping Worker wake and queued prompt ordering;
- Worker replacement while preserving Telegram Topic identity;
- global revision freshness before execution;
- General/ALL fail-closed tests;
- existing topic isolation suite;
- Core/runtime identity checks.

Production verification remains GitHub-first and Railway-backed: repository checks, CI, deployment logs, then a real Telegram canary. No phase is called complete from healthchecks alone.

## Rollback strategy

Until Phase 6, the Railway Bot remains available as the production control path. Cloudflare routing is feature-gated per Topic/canary. A failed Cloudflare canary disables new Cloudflare allocations and returns the canary Topic to a safe non-executing state or the explicitly supported previous owner; it must not create dual ownership.

After full cutover, rollback means redeploying the last known-good Cloudflare revision and preserving Durable Object state. Worker generations prevent stale Railway nodes from becoming active during rollback.

## First implementation slice

The first code slice after approval is intentionally narrow:

1. define a provider-neutral provisioning interface;
2. adapt the existing Railway client/provisioner behind it;
3. replace fixed two-pool/four-node assumptions with a lazy backend/project capacity model;
4. add an image-source option to the Worker deployment contract;
5. add tests proving Worker reuse, project rollover and quota failure behavior;
6. keep current production behavior unchanged until the Cloudflare package exists and a later canary is explicitly enabled.

This slice creates the seam required for Cloudflare without prematurely moving Telegram traffic or deleting the working Railway Bot.