# Topic-Isolation Architecture (Multi AI Chat)

The bot's core product goal is **multiple AI chats running concurrently inside one Telegram
forum supergroup**: every Topic is an independent OpenCode session with its own model, agent,
keyboard, streaming output, context accounting, and setup flows — while all of them share one
OpenCode server, one Telegram bot process, and one runtime state store.

This document describes the invariants the codebase enforces to make that safe, and the
mechanisms behind them.

## The four layers

```
Telegram update ──► auth middleware ──► topic context middleware ──► routers/handlers
                          │                      │
                          ▼                      ▼
                 AsyncLocalStorage TopicRuntimeContext (per-async-execution scope)
                          │
        ┌─────────────────┼───────────────────────┐
        ▼                 ▼                        ▼
  OpenCode SSE     topic-event-bus          topic-scoped state
  (one stream      per-event routing +       (scoped singletons
   per directory)  ALS re-binding)           + session-keyed maps)
```

### 1. Session identity: bindings + runtime states

- **Telegram topic ↔ OpenCode session** mapping lives in `app/services/telegram-topic-store.ts`
  (persisted bindings: `chatId + threadId → sessionId + directory`).
- Per-topic settings (model, agent, variant, compact, run state) live in
  `app/stores/topic-runtime-state-store.ts` keyed by `chatId:threadId`. The store's `settings`
  object is the single source of truth; a legacy top-level duplication of
  `session/model/agent/compactOutputMode` existed historically and is no longer written.

### 2. Execution scope: AsyncLocalStorage

`app/services/topic-runtime-context.ts` exposes `runInTopicRuntimeContext()` and
`getTopicScopeKey()`. Two entry points establish the scope:

- **Inbound Telegram updates**: `bot/middleware/auth.ts` resolves the topic from the message
  (or callback message) and wraps the *entire* downstream pipeline — including session attach,
  keyboard binding, and the reply — in the topic context. `bot/index.ts` re-establishes the
  same scope (and swaps `ctx.api` to a topic-aware Bot) for callbacks and messages alike.
- **Outbound OpenCode events**: `opencode/topic-event-bus.ts` resolves the binding for every
  event's session and dispatches subscriber callbacks inside that topic's runtime context.
  Per-session dispatch chains preserve ordering within a session while different sessions run
  concurrently.

Anything that needs "which Topic is this for?" must read the ALS context (or take an explicit
session key). Functions that resolve ambient state (e.g. `getCurrentSession()`,
`getStoredModel()`) are therefore correct per Topic as long as callers keep this discipline.

### 3. Scoped state: the keying rules

Every piece of mutable state must be keyed by one of:

| Kind | Key | Examples |
| --- | --- | --- |
| Telegram-side | `chatId:threadId` (from ALS) | `attachManager`, `interactionManager`, `questionManager`, `permissionManager`, `renameManager`, prompt attachment, setup wizards (`TopicScopedValue`) |
| OpenCode-side | `sessionId` | `assistantRunState`, `promptQueue`, `foregroundSessionState`, streamers (`ResponseStreamer`, `ToolCallStreamer`, `CompactProgressStreamer`), `interactionEventGate`, completion task queues, `pinnedMessageManager` context accounting |
| Cross-cutting | explicit argument | keyboard states (`keyboardManager.states` by sessionId), artifact delivery targets (captured `{chatId, threadId}` at event time) |

Rules:

1. **No module-level single-slot mutable state for user-facing flows.** Anything a user can be
   "in the middle of" (a wizard step, a pending answer, a streamed partial) must live under a
   topic/session key.
2. **Never tear down another topic's work from within one topic.** Global teardown
   (`stopEventListening()`, aggregator `clear()` of *all* scopes, `clearAll*()` streamers) is
   allowed only on full bot shutdown/startup and deliberate project switches — not inside
   per-topic message, callback, or model-switch paths.
3. **Focus changes must be non-destructive.** `summaryAggregator.setSession()` updates the
   fallback focus pointer without wiping in-flight aggregation state; correctness under
   concurrency comes from per-event context gating (`activeSessionId()`), not from clearing.

`app/services/topic-scoped-value.ts` is the minimal primitive for rule 1: one mutable value
per topic scope, resolved from the ALS context at each get/set.

`app/services/topic-scoped-singleton.ts` (`installTopicScopedSingleton`) wraps the whole
`summaryAggregator` class so each topic gets its own aggregation instance while callbacks
registered on the base instance are shared.

### 4. Concurrency & liveness

- **Answer finalization is per-session serialized**: `event-subscription-service` keeps a
  completion task queue per sessionId; assistant text, thinking streams, and tool streams are
  per-session keyed, and the final assistant answer is finalized last (thinking/reasoning
  updates arriving after `hasCompletedResponse` are dropped so the answer is always the last
  message in a Topic).
- **Rate limiting is per call site**: Telegram 429 retries are handled per-request; a slow
  topic cannot block another topic's sends (streams never share timers across sessions).
- **Stuck runs self-heal**: the session stall watchdog, busy reconciliation on
  `server.heartbeat`, and session-idle finalization guarantee a Topic that loses its terminal
  event (e.g. during an SSE reconnect gap) returns to a usable state instead of staying busy
  forever.

## Verification

CI (GitHub Actions, `.github/workflows/ci.yml`) runs `npm run lint`, `npm run typecheck`
and the vitest suite under `.github/ci-tests/` for every PR. Isolation invariants have
dedicated tests:

- `tests/app/services/topic-scoped-value.test.ts` — per-topic wizard scopes.
- `tests/bot/pinned/pinned-message-manager.test.ts` — per-session context accounting.
- `tests/bot/keyboards/keyboard-manager-scope.test.ts` — Topic keyboard state resolution.
- `tests/app/managers/summary-aggregation-manager.test.ts` — concurrent-topic event flow.
- `tests/bot/services/event-subscription-service.lifecycle.test.ts` — final-answer ordering.
- `tests/app/services/topic-scoped-singleton.clear-isolation.test.ts` — aggregator scope.

## Known intentional exceptions

- The main/General chat keeps a legacy single-focus model: while it is the only unscoped
  context it may still consider "any run active" for its own interaction gating
  (`isForegroundBusy()` fallback) — Topics are excluded from it via ALS scoping.
- Scheduled-task notifications deliver to the chat root by design; the global busy gate only
  defers them until the next completion/idle event.
- `clearPromptResponseMode()` remains as a no-op seam because several command tests assert on
  its call sites; removing it is a pure test-plumbing cleanup unrelated to isolation.
