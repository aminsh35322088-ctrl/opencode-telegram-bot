# Per-Binding Worker Isolation Architecture Spec

## Decision

Adopt a Gateway, Supervisor, and isolated worker lifecycle per binding architecture. The first implementation keeps the shared OpenCode server and runs topic workers as child processes inside the existing Railway container. A later phase may move OpenCode and persistent data into separate containers or VMs.

The primary goal is functional and lifecycle isolation: no AI Topic may deliver events, state changes, callbacks, tool results, scheduled-task results, or model responses to another AI Topic or to General/ALL.

## Confirmed Policy

- Every AI Topic is identified by a canonical `(chatId, threadId)` binding and an exact `(sessionId, normalizedDirectory)` pair.
- General/ALL is navigation and read-only history only. It may never start a model worker, dispatch a prompt, execute a model-backed command or skill, create a scheduled model task, or send model-derived output.
- An unbound or ambiguous Topic is fail-closed. It is never upgraded to a global session, another Topic, or General.
- A route missing an exact binding, a stale `bindingGeneration`, a deleted binding, or a mismatched directory produces no model operation and no outbound Telegram mutation.
- Duplicate binding identities are invalid. Lookup and persistence must normalize paths consistently and reject ambiguity.

## Current Constraints

The production container currently runs one Node process, one Telegram long-polling consumer, and one OpenCode server at `127.0.0.1:4096`. Multiple processes cannot independently call Telegram `getUpdates` or own the same bot token. The deployment therefore requires:

- exactly one Telegram poller;
- exactly one Gateway authority;
- exactly one active application replica;
- one Supervisor owning worker lifecycle;
- no multiple `getUpdates` consumers.

The worker architecture must be compatible with the existing shared persistent volume, but no topic worker may write another topic's mutable runtime state.

## Architecture

### Gateway

The Gateway is the only process that:

- owns Telegram long polling;
- authenticates updates;
- resolves message and callback Topic identity;
- rejects General, unbound, ambiguous, and stale routes for model work;
- creates, binds, deletes, and rotates Topic bindings;
- forwards inbound work through the worker IPC contract;
- validates and performs every outbound Telegram mutation;
- owns the Telegram bot token and any Telegram-only credentials.

The Gateway does not call model, session-prompt, streaming, tool, watchdog, or worker business functions directly.

### Supervisor

The Supervisor may initially be a component of the Gateway process. It:

- maintains an isolated worker lifecycle per binding;
- lazily starts workers for active or newly active bindings;
- applies an idle-stop policy to idle workers;
- records worker state and `bindingGeneration`;
- restarts a crashed worker without restarting other workers;
- fences old `bindingGeneration` values before replacement;
- performs startup reconciliation for orphaned workers, bindings, and state roots.

The Supervisor is not a Telegram consumer and cannot make model calls.

### Topic Worker

Each worker owns exactly one binding and all state associated with it:

- OpenCode session operations;
- prompt queues and message merging;
- SSE subscriptions and event dispatch;
- response and tool streamers;
- watchdog and recovery state;
- model, agent, variant, and capability selection;
- interaction, question, permission, rename, and wizard state;
- scheduled-task execution for that Topic;
- workspace-relative file and tool operations.

A worker receives an immutable Topic envelope and cannot resolve another binding from ambient global state. It has no fallback to `getCurrentSession()`, `__main__`, General, or the last focused Topic.

Workers do not receive the Telegram bot token. They submit outbound commands to the Gateway, which revalidates the binding and `bindingGeneration` before sending.

## IPC Contract

The same contract is used in Phase 1 with an in-process transport and in Phase 2 with a child-process transport. The Gateway must not call worker functions directly.

### Inbound envelope

Every model-capable inbound request contains an immutable envelope equivalent to:

```ts
interface TopicEnvelope {
  bindingId: string;
  chatId: number;
  threadId: number;
  sessionId: string;
  directory: string;
  bindingGeneration: number;
  runId: string | null;
  operation: string;
  updateId?: number;
  payload: unknown;
}
```

The Gateway validates the envelope against the canonical binding registry before dispatch. A worker validates the same envelope again before executing an operation.

### Outbound envelope

Every worker output, Telegram mutation, state mutation, scheduled-task delivery, tool completion, and event delivery uses an outbound envelope equivalent to:

```ts
interface OutboundEnvelope {
  bindingId: string;
  chatId: number;
  threadId: number;
  sessionId: string;
  directory: string;
  bindingGeneration: number;
  runId: string | null;
  kind: string;
  payload: unknown;
}
```

The Gateway rejects envelopes with missing fields, duplicate bindings, mismatched session or directory, stale `bindingGeneration`, stale `runId`, or a route other than the active binding.

### Run identity

The Gateway allocates a unique `runId` for every model-capable operation and a new run for each scheduled-task execution. The worker records the active `runId` per session and rejects model-derived events, tool completions, permission results, edits, and final output when it belongs to a different run.

A `runId` may be `null` only for operations or events that are explicitly session-lifecycle scoped, such as a heartbeat or a session-status event that is not attributable to a model execution. Such events still require exact session and directory identity, the current `bindingGeneration`, and a valid binding. A non-null event `runId` must match the active run for that session before it can mutate state or produce output.

### `bindingGeneration` semantics

`bindingGeneration` is a persisted, monotonically increasing fencing token scoped to one `bindingId`. A newly created binding starts at `1`; the token is never decremented or reused, including after deletion and recreation.

The Supervisor increments and persists the token before replacing or rebinding a worker, rotating or rebinding a session, migrating execution mode, or restarting a worker incarnation after a crash or application restart. The old `bindingGeneration` is fenced before the replacement can emit anything. An idle stop and later resume counts as a replacement and therefore uses a new `bindingGeneration`.

The Gateway and worker reject an envelope when its `bindingGeneration` is lower than the current token or when it does not equal the currently active `bindingGeneration`. A worker never changes its own `bindingGeneration` to accept a late event.

### Replay and ordering

The envelope includes an operation or event identity. The Gateway and worker must make dispatch idempotent so a retried IPC message cannot create a second prompt, edit, callback action, or scheduled-task delivery. Ordering is preserved per session; unrelated sessions may progress independently.

### Shared OpenCode SSE revalidation

Because Phase 1 and Phase 2 use one shared OpenCode server, an SSE event is not trusted merely because it arrived on a directory subscription. Before dispatch or state mutation, the worker and event gateway revalidate:

- exact `sessionId` and normalized directory;
- the current canonical `bindingId` and `bindingGeneration`;
- `runId` for every model-derived event, tool completion, permission result, stream chunk, and final response;
- the current worker incarnation and active run.

Session-lifecycle events with no attributable `runId` must still match the exact session, directory, binding, and `bindingGeneration`. Any mismatch is dropped before callbacks, stream mutations, or Telegram output.

## State and Storage

- Each binding gets a private runtime-state root, queue directory, lock directory, log directory, and workspace boundary.
- The binding registry is the only shared mutable routing and lifecycle coordination store. It is written atomically and is not used as a fallback session selector. Global provider health, rate-limit state, model catalog/cache, capability metadata, and global configuration may be shared; conversation, prompt, stream, tool, and runtime state may not.
- Registry readers and writers use the same serialization mechanism, with normalized paths and duplicate detection.
- Topic state persistence is per binding and flushed before a worker reports a successful migration or deletion.
- A missing or malformed state root fails closed; it is never replaced by another Topic's state.
- Session, directory, and binding identity remain explicit in all durable task records. Scheduled tasks never call Telegram directly: they submit an outbound envelope containing `bindingId` and `bindingGeneration`, and the Gateway performs route validation before delivery.

## Durable Scheduler Control Plane

The scheduler is outside TopicWorker processes because workers may be stopped while idle. A durable scheduler record contains the origin `bindingId`, `chatId`, `threadId`, `sessionId`, normalized directory, and schedule. At fire time the scheduler:

1. reloads the current binding and verifies that it still exists and is unambiguous;
2. obtains the current `bindingGeneration` and allocates a new `runId`;
3. calls `ensureWorker(binding)` and waits for that worker to become ready;
4. dispatches a normal inbound `TopicEnvelope` with the current `bindingGeneration` and new `runId`;
5. receives the worker's outbound envelope and submits it to the Gateway for final route validation and Telegram delivery.

A task created in Topic A may run only while A still has a valid binding. It must never fall back to General, another Topic, or a global session. A deleted, ambiguous, or stale task is rejected or retained as an explicit error according to the durable task policy; it is never silently rerouted.

## Lifecycle and Migration

### Phase 0: Regression-first hardening

Before changing the process architecture, add regression tests that reproduce current leaks. Tests must fail against the current implementation where they expose a bug and pass only after the corresponding invariant is fixed.

Required invariants include:

- Topic A cannot send state, event, or output to Topic B.
- General/ALL cannot make a model call or start a worker for text, media, command, task, skill, or callback input.
- Unbound and ambiguous routes are fail-closed.
- Stale runs and stale `bindingGeneration` values cannot perform outbound Telegram operations or mutate topic state.
- General and AI Topic routes are never interchangeable.

Phase 0 also blocks the known General model-producing routes and removes the current event-bus fallback to a wildcard or global target.

### Phase 1: Final IPC contract in an in-process transport

Implement the Gateway/Supervisor/Worker interfaces with the final immutable envelope contract, but use an in-process transport for the first worker implementation. The Gateway must call only the IPC dispatcher. It must not import or invoke model or worker functions directly.

This phase proves serialization, validation, ordering, `bindingGeneration` fencing, and outbound routing before a process boundary is introduced.

### Phase 2: Isolated worker lifecycle per binding

Do not define Phase 2 as one permanently running child process per binding. Define it as an **isolated worker lifecycle per binding**:

- workers may be created lazily when a binding becomes active;
- idle workers may be stopped according to a bounded RAM/CPU policy;
- stopping a worker must preserve durable state and resume safely;
- starting a replacement worker uses a new `bindingGeneration`;
- the Supervisor may keep a bounded warm-worker pool, but a worker can never serve more than one binding at a time.

The migration for one binding is:

1. fence the old `bindingGeneration`;
2. stop or abort the old worker;
3. switch execution mode to child-process transport;
4. start the replacement worker with a new `bindingGeneration`;
5. attach the exact persisted session and directory;
6. mark migration complete only after the worker is ready.

Migration and rollback are per binding and `bindingGeneration`-safe. There is no global rollback that switches all Topics at once.

### Phase 3: Stronger infrastructure isolation

If security against hostile code or shared-filesystem access is required, move OpenCode, workspace, runtime state, and credentials into a separate container or VM per binding. This is not claimed by the shared-container process design.

## Railway Operational Contract

The deployment must enforce and document:

- exactly one Telegram poller;
- exactly one Gateway authority;
- exactly one active replica;
- one Supervisor owner;
- bounded worker count and bounded restart rate;
- durable binding and `bindingGeneration` state before acknowledging migration;
- graceful Gateway shutdown that stops or fences all workers without sending stale output.

Multiple Railway replicas or multiple Telegram `getUpdates` consumers are forbidden while they share the same bot identity or persistent state.

## Security and Tool Boundaries

- General/ALL has no model or tool execution authority.
- Workers validate session and directory ownership for session recovery, prompt dispatch, attachment, file, and artifact operations.
- Workspace paths are normalized and symlink-resolved before access; a path escaping the worker workspace is rejected.
- `send-file` and equivalent tools cannot use an absolute path or arbitrary session to read another Topic's workspace.
- Outbound Telegram operations always go through the Gateway and are revalidated by binding and `bindingGeneration`.
- No worker receives another binding's credentials, stream state, queue, or pending interaction state.

Process isolation in a shared container is a functional and lifecycle boundary, not a hostile-code security boundary. Hard confidentiality against malicious code requires Phase 3 isolation.

## Required Regression Matrix

The implementation must include tests for at least:

- A streaming while B streams;
- A tool execution while B streams;
- A waiting permission while B is active;
- worker A crash without disruption to workers B and C;
- stale SSE chunk;
- stale Telegram edit;
- stale callback;
- stale tool completion;
- stale permission response;
- stale scheduled task;
- worker A attempting to spoof B's binding, thread, session, directory, `bindingGeneration`, or `runId`;
- worker crash during tool execution;
- symlink or path escape from workspace A into workspace B;
- session recovery targeting another Topic's session or directory;
- `send-file` targeting another Topic's workspace;
- General/ALL text, media, command, task, skill, and callback attempts;
- unbound and ambiguous routes;
- duplicate and cross-chat bindings;
- per-binding migration, crash recovery, and rollback.

Each test must assert both the positive path and the absence of cross-topic side effects. Tests must be deterministic and must not depend on arbitrary sleeps.

## Acceptance Criteria

The design is implemented only when:

1. Regression tests added in Phase 0 reproduce every known leak before their fixes.
2. General/ALL cannot create a model call, worker, prompt, task, or model-backed tool flow.
3. No unbound or ambiguous route can reach a worker or Telegram model output.
4. Every model-derived mutation is accepted only through a matching binding, current `bindingGeneration`, and active `runId`.
5. A and B can stream, execute tools, wait for permissions, crash, recover, and stop independently.
6. The same envelope contract works through the in-process and child-process transports.
7. Migration and rollback affect one binding at a time and survive process restart.
8. CI runs lint, typecheck, build, unit/integration tests, and process-boundary tests successfully.
9. Railway logs and telemetry identify binding, `bindingGeneration`, `runId`, worker lifecycle, and rejected routes without exposing secrets.
