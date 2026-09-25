# Per-Binding Worker Isolation Phase 0–1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reproduce and close current cross-Topic leaks, then introduce the final Gateway/Worker IPC contract using an in-process transport without changing the current Railway single-poller deployment.

**Architecture:** A single Telegram Gateway remains the only `getUpdates` consumer. It admits only exact bound Topics, allocates `runId` and `bindingGeneration`-fenced envelopes, and sends all model work through a dispatcher. The first worker adapter runs in the existing process; child-process lifecycle and separate OpenCode/container isolation remain Phase 2/3.

**Tech Stack:** TypeScript 5.x, Node.js 22.14+, grammy, `@opencode-ai/sdk`, AsyncLocalStorage, Vitest 3.2.4 in GitHub CI.

**Spec:** `docs/superpowers/specs/2026-09-24-per-binding-worker-isolation-design.md`

## Global Constraints

- General/ALL is navigation and read-only history only; it must never start a model worker, dispatch a prompt, execute a model-backed command or skill, create a scheduled model task, or send model-derived output.
- Unbound, ambiguous, stale-generation, stale-run, duplicate-binding, and cross-directory routes are fail-closed.
- Use `bindingId`, `bindingGeneration`, and `runId` consistently; `updateId` is not an execution identity.
- `bindingGeneration` is persisted and monotonic; every worker incarnation replacement fences the old generation before accepting output.
- Phase 1 uses the final IPC contract through an in-process transport; the Gateway must not call model or worker business functions directly.
- Phase 2 will use an isolated worker lifecycle per binding, with lazy start and bounded idle stop; do not implement permanent one-child-per-Topic behavior in this plan.
- There is exactly one Telegram poller, one Gateway authority, one Supervisor owner, and one active application replica.
- Scheduled tasks use the durable scheduler/control-plane route and never call Telegram directly.
- Do not add runtime dependencies or install packages on Railway; CI materializes tests and installs Vitest only in GitHub Actions.
- All new user-facing rejection text uses the existing i18n system; internal errors remain in logs.

---

### Task 1: Reproduce Current Isolation Leaks

**Files:**
- Modify: `.github/ci-tests/tests/opencode/events.test.ts`
- Modify: `.github/ci-tests/tests/opencode/topic-event-bus-isolation.test.ts`
- Modify: `.github/ci-tests/tests/bot/routers/message-router.test.ts`
- Modify: `.github/ci-tests/tests/bot/routers/command-router.test.ts`
- Modify: `.github/ci-tests/tests/bot/callbacks/callback-router.test.ts`
- Create: `.github/ci-tests/tests/app/services/telegram-reply-context-isolation.test.ts`
- Modify: `.github/ci-tests/tests/app/services/scheduled-task-runtime-service.test.ts`
- Modify: `.github/ci-tests/tests/bot/services/event-subscription-service.test.ts`
- Modify: `.github/ci-tests/tests/bot/services/event-subscription-service.lifecycle.test.ts`

**Interfaces:**
- Consumes: existing `authMiddleware`, `registerMessageRouter`, `registerCallbackRouter`, `subscribeToEvents`, `subscribeToTopicEvents`, `scheduledTaskRuntime`, and `enrichTelegramReplyContext`.
- Produces: failing regression cases that define the Phase 0 admission and no-side-effect contract.

- [ ] **Step 1: Change the existing General event test to reproduce the leak**

Replace the current unscoped callback expectation with a fail-closed expectation. The test must cover an unbound event with no binding and an event with exactly one directory binding:

```ts
it("does not deliver model events to a General wildcard subscriber", async () => {
  const event = {
    type: "message.updated",
    properties: { sessionID: "session-a", directory: "/workspace" },
  } as unknown as Event;
  subscribeMock.mockImplementation(async (_parameters: unknown, params: { signal?: AbortSignal }) => ({
    stream: createStream([event], params?.signal ?? new AbortController().signal),
  }));
  bindings.bySession.mockResolvedValue(null);
  bindings.byDirectoryList.mockResolvedValue([
    { chatId: 100, threadId: 11, sessionId: "session-a", directory: "/workspace" },
  ]);

  const callback = vi.fn();
  const subscription = subscribeToEvents("/workspace", callback);
  void subscription.catch(() => undefined);

  await new Promise((resolve) => setTimeout(resolve, 30));

  expect(callback).not.toHaveBeenCalled();
  stopEventListening();
});
```

- [ ] **Step 2: Add event-bus tests for missing and ambiguous routes**

Add tests to `topic-event-bus-isolation.test.ts` for:

```ts
it("drops a scoped event when the binding lookup is ambiguous", async () => {
  const event = { type: "message.updated", properties: { sessionID: "session-a", directory: "/workspace" } } as unknown as Event;
  bindings.bySession.mockResolvedValue(null);
  bindings.byDirectory.mockResolvedValue([
    { chatId: 100, threadId: 11, sessionId: "session-a", directory: "/workspace" },
    { chatId: 100, threadId: 22, sessionId: "session-b", directory: "/workspace" },
  ]);
  subscribeMock.mockImplementationOnce(async (_parameters: unknown, options: { signal: AbortSignal }) => ({
    stream: createStream([event], options.signal),
  }));
  const callback = vi.fn();
  const subscription = subscribeToTopicEvents("/workspace", callback, "session-a");
  void subscription.ready.catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(callback).not.toHaveBeenCalled();
});

it("does not deliver a session event to a different exact session", async () => {
  const event = { type: "message.updated", properties: { sessionID: "session-b", directory: "/workspace" } } as unknown as Event;
  bindings.bySession.mockImplementation(async (sessionId: string) => sessionId === "session-a"
    ? { chatId: 100, threadId: 11, sessionId: "session-a", directory: "/workspace" }
    : { chatId: 100, threadId: 22, sessionId: "session-b", directory: "/workspace" });
  subscribeMock.mockImplementationOnce(async (_parameters: unknown, options: { signal: AbortSignal }) => ({
    stream: createStream([event], options.signal),
  }));
  const callback = vi.fn();
  const subscription = subscribeToTopicEvents("/workspace", callback, "session-a");
  void subscription.ready.catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(callback).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Add General and unbound media/command tests**

In `message-router.test.ts`, define the handler lookup and media context explicitly before the table test:

```ts
function getMessageHandler(eventName: string): (ctx: unknown, next: () => Promise<void>) => Promise<void> {
  const bot = { on: vi.fn(), hears: vi.fn() };
  registerMessageRouter(bot as never, {
    ensureEventSubscription: vi.fn(),
    setTelegramContext: vi.fn(),
  });
  const call = bot.on.mock.calls.find(([event]) => event === eventName);
  return defined(call?.[1]) as (ctx: unknown, next: () => Promise<void>) => Promise<void>;
}

function makeMediaContext({ chatId, threadId }: { chatId: number; threadId: number }) {
  return {
    chat: { id: chatId, type: "supergroup", is_forum: true },
    message: { message_thread_id: threadId },
    reply: vi.fn().mockResolvedValue(undefined),
  };
}
```

Then run the table:

```ts
it.each(["message:voice", "message:audio", "message:photo", "message:video", "message:video_note", "message:document"])(
  "does not dispatch %s to the model in General",
  async (eventName) => {
    const handler = getMessageHandler(eventName);
    const ctx = makeMediaContext({ chatId: 42, threadId: 1 });
    await handler(ctx, vi.fn());
    expect(mergerMock.queuePromptForMerging).not.toHaveBeenCalled();
  },
);
```

Add command-router tests that invoke `/task`, `/commands`, and `/skills` with a General context and assert zero calls to their model-backed handlers.

- [ ] **Step 4: Add unbound callback tests**

In `callback-router.test.ts`, create a callback context whose callback message has `message_thread_id: 99` and no resolved binding. Assert `handleCommandsCallback`, `handleSkillsCallback`, and `handleMessagesCallback` are not called and the callback receives a localized rejection response.

- [ ] **Step 5: Add cross-Topic reply-context regression**

Create `telegram-reply-context-isolation.test.ts` with a current Topic `101` and replied message Topic `202`. Assert that text, photo, document, and video-frame enrichment returns no model attachment from the replied message and does not write into the current workspace.

- [ ] **Step 6: Add scheduled-task and outbound regressions**

Add the following cases using the existing test setup helpers:

```ts
it("does not execute or deliver a task without a bound Topic", async () => {
  const runtime = new ScheduledTaskRuntime();
  const deliverySender = await createDeliverySender();
  mocked.tasks = [createTask({ id: "task-without-binding" })];
  await runtime.initialize({ api: {} } as Bot<Context>, deliverySender);
  await (runtime as unknown as { executeTask(taskId: string): Promise<void> }).executeTask("task-without-binding");
  expect(mocked.executeScheduledTaskMock).not.toHaveBeenCalled();
  expect(deliverySender.send).not.toHaveBeenCalled();
  runtime.__resetForTests();
});

it("does not send a late event after the session target is removed", async () => {
  const { api, summaryAggregator, service } = await setupService({ startAssistantRun: true });
  service.setTelegramContext(null, null);
  const writesBefore = countTelegramWrites(api);
  emitAssistantTextPart(summaryAggregator, "late");
  await settle();
  expect(countTelegramWrites(api)).toBe(writesBefore);
});
```

The second case belongs in `event-subscription-service.lifecycle.test.ts`, where `setupService`, `emitAssistantTextPart`, `countTelegramWrites`, and `settle` already exist.

- [ ] **Step 7: Run the failing regression set in CI**

Run the GitHub Actions test command after materializing the tests:

```bash
npm run lint
npm run typecheck
npx vitest run --config .github/ci-tests/vitest.config.ts \
  tests/opencode/events.test.ts \
  tests/opencode/topic-event-bus-isolation.test.ts \
  tests/bot/routers/message-router.test.ts \
  tests/bot/callbacks/callback-router.test.ts \
  tests/app/services/telegram-reply-context-isolation.test.ts \
  tests/app/services/scheduled-task-runtime-service.test.ts \
  tests/bot/services/event-subscription-service.test.ts
```

Expected result before implementation: the new strict-isolation assertions fail against the current fallback behavior. Do not change expectations to make the current implementation pass.

- [ ] **Step 8: Commit the reproduction tests**

```bash
git add .github/ci-tests/tests
git commit -m "test: reproduce topic isolation leaks"
```

---

### Task 2: Add the Canonical Envelope and Binding Identity Primitives

**Files:**
- Create: `src/app/services/topic-worker-protocol.ts`
- Create: `.github/ci-tests/tests/app/services/topic-worker-protocol.test.ts`
- Modify: `src/app/services/telegram-topic-store.ts`
- Create: `.github/ci-tests/tests/app/services/telegram-topic-store.isolation.test.ts`

**Interfaces:**
- Consumes: persisted `TelegramTopicBinding` records and existing `runInTopicRuntimeContext`.
- Produces: `TopicEnvelope`, `OutboundEnvelope`, `TopicBindingRef`, validation functions, canonical directory normalization, and persisted `bindingId`/`bindingGeneration`.

- [ ] **Step 1: Write protocol tests first**

Create tests with these exact contract cases:

```ts
it("rejects a stale bindingGeneration", () => {
  const envelope = makeEnvelope({ bindingGeneration: 3 });
  expect(validateTopicEnvelope(envelope, { bindingGeneration: 4, runId: "run-4" })).toEqual({
    accepted: false,
    reason: "stale_binding_generation",
  });
});

it("rejects a stale runId", () => {
  const envelope = makeEnvelope({ runId: "run-old" });
  expect(validateTopicEnvelope(envelope, { bindingGeneration: 3, runId: "run-current" })).toEqual({
    accepted: false,
    reason: "stale_run",
  });
});

it("allows a null runId only for a lifecycle operation", () => {
  expect(validateTopicEnvelope(
    makeEnvelope({ operation: "session.heartbeat", runId: null }),
    { bindingGeneration: 3, runId: "run-current" },
  )).toEqual({ accepted: true, reason: null });
});
```

- [ ] **Step 2: Add the protocol types and validators**

Create `topic-worker-protocol.ts` with these exported contracts:

```ts
export interface TopicBindingRef {
  bindingId: string;
  chatId: number;
  threadId: number;
  sessionId: string;
  directory: string;
  bindingGeneration: number;
}

export interface TopicEnvelope extends TopicBindingRef {
  runId: string | null;
  operation: string;
  operationId: string;
  updateId?: number;
  payload: unknown;
}

export interface OutboundEnvelope extends TopicBindingRef {
  runId: string | null;
  kind: string;
  operationId: string;
  payload: unknown;
}

export type EnvelopeRejectionReason =
  | "missing_binding"
  | "stale_binding_generation"
  | "stale_run"
  | "invalid_route"
  | "invalid_run_id";

export const LIFECYCLE_OPERATIONS = new Set([
  "session.heartbeat",
  "session.status",
  "session.idle",
  "session.error",
]);

export function validateTopicEnvelope(
  envelope: TopicEnvelope,
  current: Pick<TopicBindingRef, "bindingGeneration"> & { runId: string | null },
): { accepted: true; reason: null } | { accepted: false; reason: EnvelopeRejectionReason };
export function validateOutboundEnvelope(
  envelope: OutboundEnvelope,
  current: Pick<TopicBindingRef, "bindingGeneration"> & { runId: string | null },
): { accepted: true; reason: null } | { accepted: false; reason: EnvelopeRejectionReason };
export function createRunId(): string;
export function normalizeTopicDirectory(directory: string): string;
```

`validateTopicEnvelope` must reject missing/empty `bindingId`, non-positive thread IDs, non-positive generations, a non-null empty `runId`, and a model-capable operation with `runId: null`. Lifecycle operations explicitly listed by `LIFECYCLE_OPERATIONS` may use `runId: null`.

Define the test helper in the protocol test file:

```ts
function makeEnvelope(overrides: Partial<TopicEnvelope> = {}): TopicEnvelope {
  return {
    bindingId: "binding-a",
    chatId: 100,
    threadId: 11,
    sessionId: "session-a",
    directory: "/workspace",
    bindingGeneration: 1,
    runId: "run-1",
    operation: "prompt.dispatch",
    operationId: "operation-1",
    payload: {},
    ...overrides,
  };
}
```

- [ ] **Step 3: Extend persisted bindings with canonical identity**

Extend `TelegramTopicBinding` with `bindingId: string` and `bindingGeneration: number`. Read legacy records by deriving a stable binding ID from `chatId:threadId` and defaulting the generation to `1`. Normalize directories before all comparisons. Reject duplicate session IDs across bindings and duplicate `(chatId, threadId)` identities during writes. Make missing update targets throw instead of silently succeeding.

- [ ] **Step 4: Add binding-store tests**

Test legacy migration, case/slash normalization, duplicate session rejection, duplicate thread rejection, missing update rejection, and generation preservation across reads/writes.

- [ ] **Step 5: Run protocol and binding tests**

```bash
npm run lint
npm run typecheck
npx vitest run --config .github/ci-tests/vitest.config.ts \
  tests/app/services/topic-worker-protocol.test.ts \
  tests/app/services/telegram-topic-store.isolation.test.ts
```

- [ ] **Step 6: Commit the protocol primitives**

```bash
git add src/app/services/topic-worker-protocol.ts \
  src/app/services/telegram-topic-store.ts \
  .github/ci-tests/tests/app/services/topic-worker-protocol.test.ts \
  .github/ci-tests/tests/app/services/telegram-topic-store.isolation.test.ts
git commit -m "feat: add topic worker envelope protocol"
```

---

### Task 3: Enforce the Gateway Admission Gate

**Files:**
- Create: `src/bot/services/topic-admission-gate.ts`
- Create: `.github/ci-tests/tests/bot/services/topic-admission-gate.test.ts`
- Modify: `src/bot/middleware/auth.ts`
- Modify: `src/bot/index.ts`
- Modify: `src/bot/routers/message-router.ts`
- Modify: `src/bot/routers/command-router.ts`
- Modify: `src/bot/callbacks/callback-router.ts`
- Modify: `.github/ci-tests/tests/bot/routers/message-router.test.ts`
- Modify: `.github/ci-tests/tests/bot/callbacks/callback-router.test.ts`

**Interfaces:**
- Consumes: `findTelegramTopicBindingByThread`, `TopicEnvelope`, and `TopicBindingRef`.
- Produces: `admitTopicUpdate()` and `admitCallbackUpdate()` decisions consumed by the Gateway before any model path.

- [ ] **Step 1: Write admission tests**

Use the following decision contract:

```ts
export type TopicAdmission =
  | { kind: "topic"; binding: TopicBindingRef; runId: string | null }
  | { kind: "general_readonly"; reason: "general_or_unbound" }
  | { kind: "reject"; reason: "unbound_topic" | "ambiguous_topic" | "invalid_topic" };
```

Test exact-bound Thread `11`, General/root, unbound Thread `99`, duplicate bindings, and callback messages whose thread does not match the callback payload. A model-capable operation must return `reject` for General and unbound paths; only read-only navigation may return `general_readonly`.

- [ ] **Step 2: Implement the admission gate**

`topic-admission-gate.ts` must extract the Telegram message/callback thread, load the canonical binding, verify `threadId > 1`, and return a `TopicBindingRef`. It must never call `getCurrentSession()` or `process.cwd()` to fill missing identity. A binding lookup that returns multiple records is `ambiguous_topic` and is rejected.

- [ ] **Step 3: Make auth middleware establish the exact context**

Replace the unbound `runInTopicRuntimeContext({ chatId, threadId }, next)` path with a rejection before `next()`. Callback messages must resolve their `message_thread_id` before any callback handler runs. Re-enter the runtime context with `bindingId`, `sessionId`, `directory`, and `bindingGeneration`; never omit `directory` or fall back to a global session.

- [ ] **Step 4: Gate all model-backed router entry points**

Before text merging, media handlers, task text, command/skill catalog arguments, scheduled-task creation, session history forks, compact confirmation, and model-backed callbacks, require `kind: "topic"`. General may continue only to the existing navigation/read-only handlers. Use the existing i18n key for the rejection; do not expose binding or filesystem details.

- [ ] **Step 5: Run admission regressions**

```bash
npm run lint
npm run typecheck
npx vitest run --config .github/ci-tests/vitest.config.ts \
  tests/bot/services/topic-admission-gate.test.ts \
  tests/bot/routers/message-router.test.ts \
  tests/bot/routers/command-router.test.ts \
  tests/bot/callbacks/callback-router.test.ts
```

- [ ] **Step 6: Commit the admission gate**

```bash
git add src/bot/services/topic-admission-gate.ts \
  src/bot/middleware/auth.ts src/bot/index.ts \
  src/bot/routers/message-router.ts src/bot/routers/command-router.ts \
  src/bot/callbacks/callback-router.ts \
  .github/ci-tests/tests/bot/services/topic-admission-gate.test.ts \
  .github/ci-tests/tests/bot/routers \
  .github/ci-tests/tests/bot/callbacks/callback-router.test.ts
git commit -m "feat: enforce strict topic admission"
```

---

### Task 4: Add the In-Process Worker Dispatcher Boundary

**Files:**
- Create: `src/app/services/topic-worker-dispatcher.ts`
- Create: `src/app/services/topic-worker-runtime.ts`
- Create: `.github/ci-tests/tests/app/services/topic-worker-dispatcher.test.ts`
- Modify: `src/bot/index.ts`
- Modify: `src/app/bootstrap/start-bot-app.ts`
- Modify: `.github/ci-tests/tests/app/start-bot-app.test.ts`

**Interfaces:**
- Consumes: `TopicEnvelope`, `OutboundEnvelope`, `admitTopicUpdate()`, and the existing prompt/event service methods.
- Produces: the only Gateway-to-worker call boundary.

- [ ] **Step 1: Write dispatcher tests**

```ts
function makeDispatcher(worker: TopicWorker): TopicWorkerDispatcher {
  return new TopicWorkerDispatcher([worker], {
    currentBinding: (bindingId) => bindingId === "binding-a"
      ? { bindingGeneration: 1, runId: "run-1" }
      : null,
    outboundSink: vi.fn().mockResolvedValue(undefined),
  });
}

it("dispatches only a valid exact envelope", async () => {
  const worker: TopicWorker = {
    bindingId: "binding-a",
    handleInbound: vi.fn().mockResolvedValue(undefined),
  };
  const dispatcher = makeDispatcher(worker);
  await dispatcher.dispatch(makeEnvelope({ bindingGeneration: 1, runId: "run-1" }));
  expect(worker.handleInbound).toHaveBeenCalledTimes(1);
});

it("rejects a worker envelope for another binding without invoking the worker", async () => {
  const worker: TopicWorker = {
    bindingId: "binding-a",
    handleInbound: vi.fn(),
  };
  const dispatcher = makeDispatcher(worker);
  await dispatcher.dispatch(makeEnvelope({ bindingId: "binding-b", chatId: 1, threadId: 22 }));
  expect(worker.handleInbound).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Implement the transport-neutral dispatcher**

Export these dispatcher contracts before implementing the methods:

```ts
export interface TopicWorker {
  readonly bindingId: string;
  handleInbound(envelope: TopicEnvelope): Promise<void>;
  handleOutbound?(envelope: OutboundEnvelope): Promise<void>;
}

export interface TopicWorkerDispatcherOptions {
  currentBinding(bindingId: string): Pick<TopicBindingRef, "bindingGeneration"> & { runId: string | null } | null;
  outboundSink(envelope: OutboundEnvelope): Promise<void>;
}

export class TopicWorkerDispatcher {
  constructor(workers: TopicWorker[], options: TopicWorkerDispatcherOptions);
  register(worker: TopicWorker): void;
  ensureWorker(binding: TopicBindingRef): Promise<void>;
  dispatch(envelope: TopicEnvelope): Promise<void>;
  dispatchOutbound(envelope: OutboundEnvelope): Promise<void>;
  stop(): Promise<void>;
}
```

The implementation validates envelopes before calling a worker, deduplicates `operationId`, preserves ordering per `sessionId`, and sends outbound envelopes only through the Gateway outbound sink. The Gateway must import this dispatcher, not worker business functions, for model work.

- [ ] **Step 3: Add the in-process worker adapter**

`topic-worker-runtime.ts` creates one adapter per active binding. The adapter owns the current run registry, delegates the existing session/prompt/event operations, and passes all output through `OutboundEnvelope`. It must not read ambient `getCurrentSession()` or `__main__` for model work.

- [ ] **Step 4: Wire bootstrap without a second Telegram poller**

`startBotApp.ts` constructs the Gateway dispatcher and Supervisor once, before `createBot()`. The existing bot remains the only long-polling consumer. Shutdown stops the dispatcher, fences active generations, and waits for in-process worker tasks to settle within the existing shutdown budget.

- [ ] **Step 5: Run dispatcher and bootstrap tests**

```bash
npm run lint
npm run typecheck
npx vitest run --config .github/ci-tests/vitest.config.ts \
  tests/app/services/topic-worker-dispatcher.test.ts \
  tests/app/start-bot-app.test.ts
```

- [ ] **Step 6: Commit the in-process boundary**

```bash
git add src/app/services/topic-worker-dispatcher.ts \
  src/app/services/topic-worker-runtime.ts src/bot/index.ts \
  src/app/bootstrap/start-bot-app.ts \
  .github/ci-tests/tests/app/services/topic-worker-dispatcher.test.ts \
  .github/ci-tests/tests/app/start-bot-app.test.ts
git commit -m "feat: route topic work through dispatcher"
```

---

### Task 5: Make Event Routing Run- and Generation-Aware

**Files:**
- Modify: `src/opencode/topic-event-bus.ts`
- Modify: `src/opencode/events.ts`
- Modify: `src/app/services/topic-worker-runtime.ts`
- Modify: `.github/ci-tests/tests/opencode/events.test.ts`
- Modify: `.github/ci-tests/tests/opencode/topic-event-bus-isolation.test.ts`

**Interfaces:**
- Consumes: `TopicBindingRef`, active `runId`, `bindingGeneration`, and the shared OpenCode SSE event.
- Produces: fail-closed event delivery that never invokes a General wildcard or stale worker callback.

- [ ] **Step 1: Add stale-event tests**

Add tests for a stale `bindingGeneration`, a stale `runId`, a mismatched directory, and a late chunk after worker replacement. Each test must assert both that the target callback is not called and that no state manager mutator is called.

- [ ] **Step 2: Change subscriber state to carry exact binding context**

Replace wildcard-only subscriber identity with a `TopicBindingRef` plus active run resolver. `subscribeToEvents()` must require a bound Topic in strict mode and pass `bindingId`, `bindingGeneration`, and `runId` to the bus. A General subscription may be created only for explicit read-only consumers and must not be eligible for model event callbacks.

- [ ] **Step 3: Revalidate every shared SSE event**

In `dispatchEventToSubscribers`, resolve and compare exact session ID, normalized directory, binding ID, and current `bindingGeneration` before filtering targets. For model-derived events, compare the event's run association with the worker’s active run. Drop lifecycle events with `runId: null` only when exact session, directory, binding, and generation match.

- [ ] **Step 4: Preserve child-session rules**

Keep unknown child events quarantined until a verified parent mapping exists. A child event must not use a directory-only fallback to a different parent and must never target General.

- [ ] **Step 5: Run event tests**

```bash
npm run lint
npm run typecheck
npx vitest run --config .github/ci-tests/vitest.config.ts \
  tests/opencode/events.test.ts \
  tests/opencode/topic-event-bus-isolation.test.ts \
  tests/opencode/summary-aggregator-topic-context.integration.test.ts
```

- [ ] **Step 6: Commit event fencing**

```bash
git add src/opencode/topic-event-bus.ts src/opencode/events.ts \
  src/app/services/topic-worker-runtime.ts \
  .github/ci-tests/tests/opencode/events.test.ts \
  .github/ci-tests/tests/opencode/topic-event-bus-isolation.test.ts
git commit -m "fix: fence shared SSE topic delivery"
```

---

### Task 6: Remove Ambient Outbound Fallbacks

**Files:**
- Modify: `src/bot/services/event-subscription-service.ts`
- Modify: `src/bot/services/agent-artifact-delivery-service.ts`
- Modify: `src/bot/streaming/response-streamer.ts`
- Modify: `src/bot/streaming/finalize-assistant-response.ts`
- Modify: `.github/ci-tests/tests/bot/services/event-subscription-service.test.ts`
- Modify: `.github/ci-tests/tests/bot/services/event-subscription-service.lifecycle.test.ts`
- Modify: `.github/ci-tests/tests/bot/services/agent-artifact-delivery-service.test.ts`

**Interfaces:**
- Consumes: `OutboundEnvelope`, `TopicWorkerDispatcher`, and explicit session/directory target records.
- Produces: outbound sends that cannot fall back to current session, global chat, or General.

- [ ] **Step 1: Add late-output tests**

Cover late final text, thinking stream, tool completion, artifact, Telegram edit, and error delivery after target removal, generation replacement, and run cancellation. Assert zero calls to `sendMessage`, `editMessageText`, and artifact delivery.

- [ ] **Step 2: Replace route fallback functions**

Remove `getChatIdForSession()` and `getCurrentTopicTransport()` fallbacks. Require an exact `TopicBindingRef` or `OutboundEnvelope` for every finalizer. If the target is missing, return without sending; never use `chatIdInstance`, `getCurrentSession()`, or `threadId <= 1`.

- [ ] **Step 3: Revalidate before and after awaits**

Capture the envelope at task start, then check `bindingGeneration`, `runId`, binding existence, and worker incarnation immediately before every Telegram API call and immediately before every state mutation. A late continuation must return without side effects.

- [ ] **Step 4: Route artifacts through the same sink**

Change artifact delivery to submit an `OutboundEnvelope` containing binding, generation, run, and artifact path. The Gateway sink validates the path and route before delivery.

- [ ] **Step 5: Run outbound lifecycle tests**

```bash
npm run lint
npm run typecheck
npx vitest run --config .github/ci-tests/vitest.config.ts \
  tests/bot/services/event-subscription-service.test.ts \
  tests/bot/services/event-subscription-service.lifecycle.test.ts \
  tests/bot/services/agent-artifact-delivery-service.test.ts \
  tests/bot/streaming/finalize-assistant-response.logging.test.ts
```

- [ ] **Step 6: Commit outbound fencing**

```bash
git add src/bot/services/event-subscription-service.ts \
  src/bot/services/agent-artifact-delivery-service.ts \
  src/bot/streaming/response-streamer.ts \
  src/bot/streaming/finalize-assistant-response.ts \
  .github/ci-tests/tests/bot/services
git commit -m "fix: remove ambient outbound topic fallbacks"
```

---

### Task 7: Move Scheduled Tasks Behind the Durable Scheduler Contract

**Files:**
- Modify: `src/app/types/scheduled-task.ts`
- Modify: `src/app/stores/scheduled-task-store.ts`
- Modify: `src/app/services/scheduled-task-runtime-service.ts`
- Modify: `src/app/services/scheduled-task-executor-service.ts`
- Modify: `src/bot/messages/scheduled-task-delivery.ts`
- Modify: `src/bot/commands/task-command.ts`
- Modify: `src/bot/callbacks/scheduled-task-callback-handler.ts`
- Modify: `.github/ci-tests/tests/app/services/scheduled-task-runtime-service.test.ts`
- Modify: `.github/ci-tests/tests/app/services/scheduled-task-executor-service.test.ts`
- Modify: `.github/ci-tests/tests/app/stores/scheduled-task-store.test.ts`

**Interfaces:**
- Consumes: durable `TopicBindingRef`, `TopicWorkerDispatcher.ensureWorker`, and Gateway outbound validation.
- Produces: origin-bound scheduled task records and fire-time route validation.

- [ ] **Step 1: Add scheduler tests**

Test a task created in Topic A, idle-worker scheduling, deleted binding, ambiguous binding, task restart, stale generation, and stale run delivery. The positive assertion must use `message_thread_id` A and zero calls to General or Topic B.

- [ ] **Step 2: Extend scheduled task records**

Add `bindingId`, `chatId`, `threadId`, `sessionId`, and `normalizedDirectory` to the durable task base. Reject task creation from General or an unbound Topic. Migrate legacy tasks as invalid rather than silently attaching them to a global session.

- [ ] **Step 3: Move timer ownership to the control plane**

`ScheduledTaskRuntime` may persist schedules and fire callbacks, but it must call `ensureWorker(binding)` and dispatch a fresh `TopicEnvelope` with the current `bindingGeneration` and a new `runId`. It may not own a Topic worker or call Telegram directly.

- [ ] **Step 4: Validate delivery at fire time and at output time**

Before execution, resolve the current binding and reject missing/ambiguous identity. At delivery, submit an `OutboundEnvelope` to the Gateway; the Gateway repeats route and generation validation. Remove the current `chatId` root fallback.

- [ ] **Step 5: Run scheduled-task tests**

```bash
npm run lint
npm run typecheck
npx vitest run --config .github/ci-tests/vitest.config.ts \
  tests/app/services/scheduled-task-runtime-service.test.ts \
  tests/app/services/scheduled-task-executor-service.test.ts \
  tests/app/stores/scheduled-task-store.test.ts
```

- [ ] **Step 6: Commit scheduler isolation**

```bash
git add src/app/types/scheduled-task.ts src/app/stores/scheduled-task-store.ts \
  src/app/services/scheduled-task-runtime-service.ts \
  src/app/services/scheduled-task-executor-service.ts \
  src/bot/messages/scheduled-task-delivery.ts \
  src/bot/commands/task-command.ts \
  src/bot/callbacks/scheduled-task-callback-handler.ts \
  .github/ci-tests/tests/app/services \
  .github/ci-tests/tests/app/stores/scheduled-task-store.test.ts
git commit -m "fix: bind scheduled tasks to their topic"
```

---

### Task 8: Enforce Reply, Workspace, and Tool Boundaries

**Files:**
- Modify: `src/app/services/telegram-reply-context-service.ts`
- Modify: `src/app/services/file-browser-service.ts`
- Modify: `src/app/services/session-service.ts`
- Modify: `.opencode/tools/send-file.ts`
- Modify: `.opencode/tools/session-recovery.ts`
- Modify: `.github/ci-tests/tests/app/services/telegram-reply-context-isolation.test.ts`
- Modify: `.github/ci-tests/tests/app/services/file-browser-service.test.ts`
- Create: `.github/ci-tests/tests/opencode/tools/topic-tool-boundary.test.ts`

**Interfaces:**
- Consumes: exact `TopicBindingRef` and normalized workspace root.
- Produces: no cross-Topic reply media, session recovery, or file access.

- [ ] **Step 1: Add boundary tests**

Cover a reply from Thread B while handling Thread A, a symlink from A to B, an absolute `send-file` path outside A, and `session-recovery` targeting B's session or directory. Assert no media is copied, no recovery API call is made, and no file is sent.

- [ ] **Step 2: Validate reply identity**

Compare the replied message's `message_thread_id` with the current Topic. Reject cross-Topic replies before reading text or downloading media. Keep same-Topic reply enrichment only when the exact binding and directory match.

- [ ] **Step 3: Resolve workspace paths before access**

Use `realpath`/`path.relative` checks after symlink resolution. Reject paths outside the current workspace, including absolute paths and `..` traversal. Apply the same check to file-browser, send-file, and attachment services.

- [ ] **Step 4: Scope model tools to the active envelope**

`session-recovery` and `send-file` must obtain session, directory, binding, and generation from the current worker envelope. A caller-supplied session or directory may be accepted only if it exactly matches the envelope; otherwise fail closed before any API call.

- [ ] **Step 5: Run boundary tests**

```bash
npm run lint
npm run typecheck
npx vitest run --config .github/ci-tests/vitest.config.ts \
  tests/app/services/telegram-reply-context-isolation.test.ts \
  tests/app/services/file-browser-service.test.ts \
  tests/opencode/tools/topic-tool-boundary.test.ts
```

- [ ] **Step 6: Commit tool boundaries**

```bash
git add src/app/services/telegram-reply-context-service.ts \
  src/app/services/file-browser-service.ts src/app/services/session-service.ts \
  .opencode/tools/send-file.ts .opencode/tools/session-recovery.ts \
  .github/ci-tests/tests/app/services \
  .github/ci-tests/tests/opencode/tools
git commit -m "fix: enforce topic workspace tool boundaries"
```

---

### Task 9: Add Process-Level Integration Tests and CI Gates

**Files:**
- Create: `.github/ci-tests/tests/app/services/per-binding-worker.integration.test.ts`
- Create: `.github/ci-tests/tests/app/services/per-binding-worker.lifecycle.test.ts`
- Modify: `.github/ci-tests/tests/opencode/topic-event-bus-isolation.test.ts`
- Modify: `.github/ci-tests/tests/bot/services/event-subscription-service.lifecycle.test.ts`

**Interfaces:**
- Consumes: the in-process dispatcher and worker adapter from Tasks 2–8.
- Produces: deterministic concurrency and failure-isolation evidence for Phase 1.

- [ ] **Step 1: Add simultaneous Topic tests**

Use deferred promises to run A streaming while B streams, A tool execution while B streams, and A permission waiting while B remains active. Assert each callback sees only its own `sessionId`, `directory`, `bindingGeneration`, and `runId`.

- [ ] **Step 2: Add stale continuation tests**

For each of SSE chunk, Telegram edit, callback, tool completion, permission response, and scheduled task, pause the continuation, replace the binding generation or cancel the run, release the promise, and assert no outbound or state side effect.

- [ ] **Step 3: Add worker failure tests**

Inject a worker exception during stream processing and during tool execution. Assert the Supervisor fences that binding, starts a replacement with a new `bindingGeneration`, and leaves another Topic's active run unchanged.

- [ ] **Step 4: Add spoof and path-escape tests**

Send an outbound envelope claiming another binding, thread, session, directory, generation, or run. Assert the Gateway rejects it before Telegram. Add a symlink escape test that attempts to read B's workspace from A.

- [ ] **Step 5: Run the full CI pipeline**

The GitHub workflow must execute the following in order:

```bash
npm run lint
npm run typecheck
npm run build
npx vitest run --config .github/ci-tests/vitest.config.ts
```

Expected result: zero lint warnings, zero type errors, successful build, and zero failed tests. Do not add a production test runner to `package.json`.

- [ ] **Step 6: Commit the integration suite**

```bash
git add .github/ci-tests/tests
git commit -m "test: verify per-binding worker isolation"
```

---

### Deferred Phase 2–3 Work

This plan intentionally stops at the in-process transport. A separate plan must cover child-process worker lifecycle, lazy worker creation, idle stop policy, per-binding migration/rollback, and shared OpenCode SSE routing across process boundaries. A later security plan must cover separate containers or VMs for hostile-code isolation.

## Plan Self-Review Checklist

- [x] Every spec Phase 0 invariant has a regression test task.
- [x] `runId`, `bindingGeneration`, durable scheduler, shared-state scope, and SSE revalidation are explicit in interfaces and tasks.
- [x] Phase 1 uses the final IPC contract before child-process transport.
- [x] General/ALL, unbound routes, cross-Topic replies, scheduled tasks, tools, and stale continuations have concrete test cases.
- [x] No task adds a second Telegram poller or a permanent one-child-per-binding worker policy.
- [x] CI uses the repository's existing GitHub Actions validation commands.
- [x] No placeholder tasks or undefined future interfaces are required by this plan.
