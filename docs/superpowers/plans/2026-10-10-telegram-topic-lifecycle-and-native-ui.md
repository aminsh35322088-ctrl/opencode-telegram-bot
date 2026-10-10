# Telegram Topic Lifecycle and Native UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the proven Telegram ReplyKeyboard UX while making New Chat backend-first, keeping Telegram native Thinking/Stop, and enforcing destructive Railway cleanup with strict Topic isolation.

**Architecture:** Cloudflare remains the lifecycle owner. A fresh Railway Worker first boots unbound (`0/0`), passes a narrowly-scoped Core `session.probe`, then is retired and identity-rotated to the real Telegram Topic before the real bound `session.create`. Managed AI Topics use ReplyKeyboard controls; All/root stays InlineKeyboard-only; manual Topics never gain AI authority.

**Tech Stack:** TypeScript/Node 22, Cloudflare Workers + Durable Objects + Queues, Railway GraphQL, grammY, Telegram Bot API rich-message drafts, OpenCode Telegram Core Python worker boundary.

**Spec:** `docs/superpowers/specs/2026-10-10-telegram-topic-lifecycle-and-native-ui-design.md`

## Global Constraints

- New Chat order is `Worker deploy -> health/OpenCode ready -> session.probe -> Telegram Topic -> identity bind/restart -> bound session.create -> READY`.
- `session.probe` is unbound-only, empty-payload-only, creates and deletes a temporary session, and leaves no durable session/run/Topic state.
- Fresh New Chat allocations never reuse a prior Service/Volume/Worker slot; no pooling is introduced.
- All/root owns Main Panel + InlineKeyboard only; managed AI Topics own ReplyKeyboard + AI routing; manual Telegram Topics are ignored.
- Topic ReplyKeyboard contains only dynamic Compact, exact model label, Delete Chat, and Topic Settings.
- ReplyKeyboard must omit `is_persistent:true`; keep Telegram's native collapse/reopen affordance.
- Pause/Resume/Abort and `/stop` alias are removed as user-facing features; Telegram native Stop is the only user-facing run cancellation path.
- `stopped_message_generation` cancels only the exact current `chatId + threadId + generation + run`.
- Short visible Thinking is `<=320` chars AND `<=4` lines; long visible Thinking exceeds either threshold. Never expose raw/private reasoning text.
- Delete Chat destroys session/runtime, Service, and Volume before deleting the Telegram Topic.
- Factory Reset deletes only proven-owned resources and fails closed with `cleanup_reconciliation_required` on ambiguous ownership.
- No new GitHub workflow files. Reuse existing Core CI/prerelease automation only.

## Review Focus

- **Unbound-to-bound crash window:** restart between probe and bound bootstrap must either converge to the exact new generation or clean the allocation; Task 4 tests this.
- **Telegram Topic created but bound session fails:** the Topic must be deleted and backend resources destroyed; Task 5 tests this.
- **Stale ReplyKeyboard text in the wrong scope:** it must be consumed/ignored and never become an AI prompt; Task 6 tests this.
- **Stale native Stop after Topic replacement:** it must not cancel the replacement generation; Task 8 tests this.
- **Provider-side orphan that only looks managed:** Factory Reset must preserve evidence and fail closed rather than delete blindly; Task 10 tests this.

---

### Task 1: Add Core `session.probe` and publish Core pre.28

**Files (Core repo `aminsh35322088-ctrl/opencode-telegram-core`):**
- Modify: `worker/node_agent.py`
- Modify: `tests/worker/test_node_agent.py`
- Create: `tests/worker/compiled_session_probe.py`
- Modify: `scripts/test-headless-runtime.sh`
- Modify: `upstream/lock.json`

**Interfaces:**
- Produces worker RPC operation `session.probe` with empty payload and no `sessionId`.
- Produces result shape `{ created: true, deleted: true }`.
- Preserves rejection of unbound `session.create`, run, credentials, mutation, and session-scoped operations.

- [ ] **Step 1: Write failing unit tests** in `tests/worker/test_node_agent.py` asserting an unbound ready Agent accepts only `session.probe`, performs POST `/session`, verifies the temporary session, deletes it, verifies absence, and leaves `boundary.get('session')` and `boundary.get('runId')` empty.
- [ ] **Step 2: Add failure tests** asserting non-empty payload, supplied `sessionId`, bound identity, not-ready Core, and probe deletion/verification failure are rejected; ordinary unbound `session.create` remains rejected.
- [ ] **Step 3: Run the focused Core test**: `python3 -m unittest discover -s tests/worker -p 'test_node_agent.py' -v`; expected: new probe tests FAIL before implementation.
- [ ] **Step 4: Implement** `Agent.session_probe(self, value) -> dict` in `worker/node_agent.py`; call it before the generic unbound-deny branch, require exact unbound/ready/no-session/no-run state, and never write the probe session ID into the boundary ledger.
- [ ] **Step 5: Add compiled qualification** in `tests/worker/compiled_session_probe.py` against the real compiled headless Core and register it in `scripts/test-headless-runtime.sh`.
- [ ] **Step 6: Run Core gates**: worker unit tests, `./scripts/test-headless-runtime.sh`, and the repository CI-equivalent commands; expected: PASS.
- [ ] **Step 7: Bump** `upstream/lock.json.telegramCoreVersion` from `1.18.33-bot.13-pre.27` to `1.18.33-bot.13-pre.28`.
- [ ] **Step 8: Commit and push Core**: `git commit -m "feat: probe unbound session lifecycle"` then push `main`.
- [ ] **Step 9: Verify existing CI and prerelease automation** publishes `v1.18.33-bot.13-pre.28` from that exact commit and publishes the immutable Worker image; record release asset SHA256 values and image digest. Do not create or modify workflow architecture for this task.

### Task 2: Pin the verified Core release and Worker image in Bot

**Files (Bot repo):**
- Modify: `core-release.lock.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/cloudflare/control-config.ts`

**Interfaces:**
- Consumes: Core `v1.18.33-bot.13-pre.28`, exact Core commit, release asset SHA256 values, exact `ghcr.io/...@sha256:...` Worker image.
- Produces: one aligned Bot/Core/runtime identity.

- [ ] **Step 1: Write/update release-alignment assertions** so Core version, commit, SDK/native asset URLs and `CONTROL_DEFAULTS.WORKER_*` must all identify the same pre.28 source.
- [ ] **Step 2: Run** `node scripts/verify-core-install.mjs`; expected: FAIL while the Bot still pins pre.27.
- [ ] **Step 3: Update all pins** to the verified pre.28 assets and exact Worker image digest; regenerate only the normal npm lock changes.
- [ ] **Step 4: Run** `node scripts/materialize-core-release.mjs && npm ci && node scripts/verify-core-install.mjs --runtime`; expected: PASS.
- [ ] **Step 5: Commit**: `git commit -m "chore: align bot with core pre.28"`.

### Task 3: Make allocation fresh-only and model the identity handoff

**Files:**
- Modify: `src/cloudflare/control-store.ts`
- Modify: `tests/cloudflare-control-store.test.ts`

**Interfaces:**
- Produces: `markSessionProbed(jobId: string): AllocationJob`.
- Produces: `rotateAllocationToTopic(jobId: string, threadId: number): AllocationJob`.
- `rotateAllocationToTopic` atomically increments generation exactly once, sets worker `chatId/threadId`, clears the old credential, moves worker to `BINDING`, updates job generation/thread/phase, and preserves this allocation's Service/Volume IDs.

- [ ] **Step 1: Add failing tests** proving `reserveAllocation()` never selects `READY_UNBOUND` or `SLEEPING` workers from earlier allocations; duplicate request IDs remain idempotent, while a retry request after verified cleanup gets a fresh worker ID/generation lineage.
- [ ] **Step 2: Add failing state tests** for `markSessionProbed` and `rotateAllocationToTopic`, including stale generation, wrong phase, duplicate rotation, invalid thread ID, and credential clearing.
- [ ] **Step 3: Run** `node --import tsx --test tests/cloudflare-control-store.test.ts`; expected: FAIL.
- [ ] **Step 4: Remove reuse selection** from `reserveAllocation`; capacity counts still include every non-REPLACED worker.
- [ ] **Step 5: Implement** the two explicit state transitions with transaction-scoped identity checks.
- [ ] **Step 6: Run the focused test**; expected: PASS.
- [ ] **Step 7: Commit**: `git commit -m "refactor: make topic allocation fresh-only"`.

### Task 4: Implement two-generation unbound-to-bound Worker provisioning

**Files:**
- Modify: `src/cloudflare/control-object.ts`
- Modify: `src/cloudflare/railway-fleet-driver.ts`
- Modify: `src/cloudflare/node-rpc.ts` only if a small identity helper is required
- Modify: `tests/cloudflare-production.test.ts`
- Modify: `tests/cloudflare-node-rpc.test.ts`
- Modify: `tests/cloudflare-railway-fleet.test.ts`

**Interfaces:**
- Produces: `unboundIdentity(workerId: string, generation?: number): Promise<RpcIdentity>` returning `chatId:0, threadId:0`.
- Bootstrap response returns `0/0` while the allocation has no Topic and the real `chatId/threadId` after generation rotation.
- Reuses only the Service/Volume belonging to the *same in-progress allocation* during identity rotation; this is not pooling/reuse across chats.

- [ ] **Step 1: Add failing bootstrap/RPC tests** proving the initial Core bootstrap identity is `0/0`, unbound `health` and `session.probe` use that exact identity, and normal bound RPC still rejects `0/0` misuse.
- [ ] **Step 2: Add failing Railway test** proving the second-generation bootstrap rotates the secret and causes a new deployment receipt/ID while keeping the same Service/Volume IDs.
- [ ] **Step 3: Add crash-window tests** for stale generation callback, lost second bootstrap, and old-generation health response after rotation.
- [ ] **Step 4: Run focused Cloudflare lifecycle tests**; expected: FAIL.
- [ ] **Step 5: Implement `unboundIdentity`** and change `/nodes/bootstrap` to emit `0/0` before Topic assignment.
- [ ] **Step 6: Extend the provisioning path** so generation N boots unbound, reaches verified deployment+health, runs `session.probe`, and is marked `SESSION_PROBED`.
- [ ] **Step 7: After Telegram Topic creation**, send unbound `retire`, require retirement success, call `rotateAllocationToTopic`, issue a fresh bootstrap token/secret, and redeploy the same allocation Service with generation N+1.
- [ ] **Step 8: Require bound deployment+health** before calling bound `session.create`; only then allow `bindTopic`.
- [ ] **Step 9: Run focused tests**; expected: PASS.
- [ ] **Step 10: Commit**: `git commit -m "feat: bind probed workers to telegram topics"`.

### Task 5: Make New Chat one locked Main Panel with clean Retry/Cancel

**Files:**
- Modify: `src/cloudflare/bot-ui.ts`
- Modify: `src/cloudflare/control-object.ts`
- Modify: `tests/cloudflare-ui.test.ts`
- Modify: `tests/cloudflare-navigation.test.ts`
- Modify: `tests/cloudflare-production.test.ts`

**Interfaces:**
- Produces UI methods `allocationProgress(job: AllocationJob, stage: string): Promise<void>` and `allocationFailure(job: AllocationJob, reason: string): Promise<void>` scoped to `forPanel(actor, chat, 0, 0)`.
- Produces actions `allocation_retry` and `allocation_cancel`.

- [ ] **Step 1: Add failing UI tests** asserting one existing Main Panel message is edited through progress stages and no provisioning progress messages are sent as new chat messages.
- [ ] **Step 2: Add failing lifecycle-order tests** asserting `createForumTopic` occurs only after successful unbound health+probe, and bound `session.create` occurs only after Topic creation + identity rotation + bound health.
- [ ] **Step 3: Add failure tests**: deploy/probe failure creates no Topic; Topic-create failure destroys backend; bound bootstrap/session failure deletes the new Topic and destroys backend. The failed Main Panel must expose exactly `Retry` and `Cancel`, with no second New Chat path.
- [ ] **Step 4: Add Retry/Cancel tests**: Retry is shown only after verified cleanup, uses a fresh request/generation/Worker/Volume lineage, and Cancel returns the same Main Panel to idle after cleanup.
- [ ] **Step 5: Implement the progress/error renderers** using the existing panel edit machinery and remove the current "notice"-style New Chat progress response.
- [ ] **Step 6: Make `newTopic()` reserve/schedule only**; move Telegram Topic creation into `advance()` after `SESSION_PROBED`.
- [ ] **Step 7: Implement terminal cleanup helper** for every pre-READY phase; it must preserve reconciliation evidence on ambiguous cleanup.
- [ ] **Step 8: Run focused tests**; expected: PASS.
- [ ] **Step 9: Commit**: `git commit -m "feat: make new chat backend-first"`.

### Task 6: Restore managed Topic ReplyKeyboard and shared model capability summary

**Files:**
- Modify: `src/bot/keyboards/main-reply-keyboard.ts`
- Modify: `src/cloudflare/bot-ui.ts`
- Modify: `src/app/services/model-routing-summary-service.ts`
- Modify: `tests/main-reply-keyboard.test.ts`
- Modify: `tests/cloudflare-topic-buttons-audit.test.ts`
- Modify: `tests/cloudflare-navigation.test.ts`
- Modify: `tests/cloudflare-ui.test.ts`

**Interfaces:**
- `createTopicKeyboard(options: { compactOutputMode?: boolean; currentModel?: ModelInfo }): Keyboard`.
- `formatModelRoutingSummary(primary: ModelInfo, catalog: UnifiedModelCatalogEntry[], routes: Map<ModelRoutingCapability, CapabilityRoute>): string`; existing `buildModelRoutingSummary()` delegates to this formatter after resolving its capability plan.
- Shared summary output includes Chat, Vision, Reasoning, Voice→Text, Image AI, Text→Voice, Tool Call, Agent Mode.

- [ ] **Step 1: Add failing keyboard tests** for exactly three rows: Compact, exact model, and `Delete Chat | Topic Settings`; assert `resize_keyboard:true` and no `is_persistent:true`.
- [ ] **Step 2: Add failing scope tests**: All/root outbound UI carries InlineKeyboard only; managed Topic messages carry ReplyKeyboard; manual Topic updates produce no AI UI and no prompt dispatch.
- [ ] **Step 3: Add failing control-order tests** proving a ReplyKeyboard control text is classified and its user message deletion resolves before the action output starts; stale/wrong-scope control text is consumed and never becomes a prompt.
- [ ] **Step 4: Add failing Compact/model tests**: Compact confirmation carries refreshed keyboard; model selection sends the full shared capability summary and the keyboard button changes to the exact selected model label.
- [ ] **Step 5: Add Reasoning to the shared model summary formatter** using existing capability metadata; keep the old Topic-creation flow and Cloudflare model-change flow on the same formatter contract.
- [ ] **Step 6: Replace Topic inline control rendering** in `CloudBotUi.keyboard()` with `sendMessage` + real `ReplyKeyboardMarkup`; remove the one-time legacy ReplyKeyboard clearing path.
- [ ] **Step 7: Update `ready()`** so `Chat #NN created` + full model summary is the first bot-authored Topic message and carries the ReplyKeyboard; add a regression asserting exactly one `sendMessage` uses the real `message_thread_id` and no duplicate root notification is sent, preserving Telegram's native Continue to thread behavior.
- [ ] **Step 8: Run focused tests**; expected: PASS.
- [ ] **Step 9: Commit**: `git commit -m "feat: restore telegram topic reply keyboard"`.

### Task 7: Remove Pause/Resume/Abort product features while retaining internal cancellation

**Files:**
- Delete: `src/bot/commands/pause-command.ts`
- Delete: `src/bot/commands/abort-command.ts`
- Delete: `src/app/managers/paused-session-manager.ts`
- Modify: `src/bot/commands/definitions.ts`
- Modify: `src/bot/routers/command-router.ts`
- Modify: `src/bot/routers/message-router.ts`
- Modify: `src/bot/routers/reply-keyboard-router.ts`
- Modify: `src/bot/interaction-classifier.ts`
- Modify: `src/bot/keyboards/keyboard-manager.ts`
- Modify: `src/cloudflare/bot-ui.ts`
- Modify dependent cleanup/start/auth/delete handlers and i18n text that exposes `/abort`, `/pause`, `/resume`, or `/stop`
- Create: `src/app/services/current-run-cancellation-service.ts`

**Interfaces:**
- `export type CancelCurrentRunResult = "confirmed" | "unconfirmed" | "maybe-finished" | "timeout" | "error" | "no-session"`.
- `export async function cancelCurrentRun(options: { sessionId?: string; directory?: string; reason: string; timeoutMs?: number }): Promise<CancelCurrentRunResult>`; when session identity is omitted it resolves the effective current session, performs the existing remote cancellation + bounded idle verification, and clears local run/queue/attachment state without rendering Telegram UI.
- No Telegram command/button/action named Pause, Resume, Abort, or Stop remains.

- [ ] **Step 1: Add failing audits/tests** asserting public command definitions, ReplyKeyboard labels, Cloudflare actions, router classifications, and help text contain none of Pause/Resume/Abort/`/stop`.
- [ ] **Step 2: Add tests for internal callers** that previously imported `abortCurrentOperation`; they must use the non-user-facing cancellation primitive without restoring legacy UI.
- [ ] **Step 3: Run relevant router/command/keyboard tests**; expected: FAIL.
- [ ] **Step 4: Extract the minimum internal cancellation service** needed by cleanup/start/auth flows, backed by the existing Core cancellation primitive.
- [ ] **Step 5: Delete legacy command/paused-state files** and remove routes, aliases, action handling, keyboard state, and stale i18n copy.
- [ ] **Step 6: Run focused tests plus `rg -n "MAIN_BUTTONS\\.(pause|resume|abort)|/pause|/resume|/abort|Alias for /abort" src`**; expected: no user-facing legacy feature references.
- [ ] **Step 7: Commit**: `git commit -m "refactor: remove legacy run controls"`.

### Task 8: Keep Telegram native Stop as exact-run cancellation

**Files:**
- Modify: `src/cloudflare/run-presentation.ts` only if fencing needs tightening
- Modify: `src/cloudflare/control-object.ts`
- Modify: `tests/cloudflare-native-generation.test.ts`
- Modify: `tests/cloudflare-production.test.ts`

**Interfaces:**
- `TelegramRunPresentationController.acceptStop(stop: NativeStop): RunDraftBinding | undefined` remains the admission/fence point.
- Accepted Stop dispatches internal `stop` only for the exact live run; late output stays fenced.

- [ ] **Step 1: Extend failing tests** for wrong thread, wrong draft, old generation, replacement session, duplicate Stop, Stop during tool activity, and Stop racing finalization; assert every active native draft uses `can_stop:true` and `keep_on_stop:false`.
- [ ] **Step 2: Assert output fencing happens synchronously before cancellation I/O** and the run cannot publish later text after Stop admission.
- [ ] **Step 3: Run** `node --import tsx --test tests/cloudflare-native-generation.test.ts tests/cloudflare-production.test.ts`; expected: any missing regression fails.
- [ ] **Step 4: Make the minimum control-object/presentation fixes**; do not map native Stop back to any legacy Abort action.
- [ ] **Step 5: Run focused tests**; expected: PASS.
- [ ] **Step 6: Commit**: `git commit -m "fix: fence native stop to exact run"`.

### Task 9: Apply the Thinking threshold without leaking private reasoning

**Files:**
- Modify: `src/cloudflare/run-presentation.ts`
- Modify: `src/bot/messages/thinking-rendering.ts` if shared threshold helpers belong there
- Modify: `tests/cloudflare-native-generation.test.ts`
- Modify existing thinking-rendering tests

**Interfaces:**
- Produces `isLongThinking(text: string): boolean` with exact rule `text.length > 320 || lineCount > 4`.
- Only provider/Core-designated display-safe reasoning summaries may be rendered; raw internal `part.text` remains excluded from Cloudflare persistence/output.

- [ ] **Step 1: Add boundary tests** for 320 chars/4 lines (short), 321 chars, and 5 lines (long).
- [ ] **Step 2: Add privacy regression** proving raw reasoning content such as `SECRET CHAIN OF THOUGHT` never enters Telegram payloads or SQLite.
- [ ] **Step 3: Add rendering tests**: short completed visible summary uses normal blockquote; long visible summary is open/non-collapsed while active and becomes `expandable_blockquote` after completion.
- [ ] **Step 4: Run focused tests**; expected: FAIL before renderer update.
- [ ] **Step 5: Implement threshold/presentation state** while preserving RTL/mixed-language rendering.
- [ ] **Step 6: Run focused tests**; expected: PASS.
- [ ] **Step 7: Commit**: `git commit -m "feat: refine native thinking presentation"`.

### Task 10: Harden Delete Chat and Factory Reset reconciliation

**Files:**
- Modify: `src/cloudflare/control-object.ts`
- Modify: `src/cloudflare/bot-ui.ts`
- Modify: `src/cloudflare/railway-fleet-driver.ts`
- Modify: `src/cloudflare/control-store.ts` if reconciliation receipts need durable fields
- Modify: `tests/cloudflare-railway-fleet.test.ts`
- Modify: `tests/cloudflare-production.test.ts`
- Modify: `tests/cloudflare-ui.test.ts`

**Interfaces:**
- Produces driver reconciliation result that classifies provider resources as `owned`, `deleted_or_pending_purge`, `unrelated`, or `ambiguous`.
- Ambiguous managed-looking resources cause `cleanup_reconciliation_required` and are never deleted by name alone.

- [ ] **Step 1: Add Delete Chat ordering tests**: ingress fence -> exact run cancellation -> session/runtime retirement -> Service destroy -> Volume destroy/verified pending purge -> binding cleanup -> Telegram `deleteForumTopic` last.
- [ ] **Step 2: Add retry/idempotency tests** for crashes after Service delete, Volume delete, and before Telegram Topic delete; Topic never returns ACTIVE.
- [ ] **Step 3: Add Factory Reset inventory tests** for proven-owned leftovers, already-deleted volumes, unrelated resources, a `topic-node-*` resource with no provable worker ownership, and manually-created Telegram Topics; manual Topics must remain untouched.
- [ ] **Step 4: Run focused tests**; expected: FAIL.
- [ ] **Step 5: Implement bounded Railway reconciliation** across known managed fleet projects; delete only resources proven by stored worker/job IDs and exact live inventory relationships.
- [ ] **Step 6: Move global config/UI wipe to after verified destructive cleanup**; on ambiguity preserve ownership evidence and render Retry/reconciliation-required instead of Completed.
- [ ] **Step 7: Run focused tests**; expected: PASS.
- [ ] **Step 8: Commit**: `git commit -m "fix: harden managed resource cleanup"`.

### Task 11: Full regression gate, deploy exact source, and production qualification

**Files:**
- Modify only test/docs files required by failures discovered during verification; production fixes go back into the owning task's files.

**Interfaces:**
- Consumes all previous tasks.
- Produces one exact GitHub `main` commit whose Cloudflare source and Core Worker image are the artifacts qualified in production.

- [ ] **Step 1: Run Bot gates**: `node --import tsx --test tests/*.test.ts`, `npm run lint`, `npm run typecheck`, `npm run build`.
- [ ] **Step 2: Materialize/run the CI-only Vitest suite exactly as `.github/workflows/ci.yml` does**; expected: all PASS.
- [ ] **Step 3: Double-check source audits** for no legacy Pause/Resume/Abort user feature, no Topic-before-probe path, no worker pooling/reuse path, and no manual-Topic AI admission.
- [ ] **Step 4: Push Bot `main`** and verify GitHub CI is green for the exact commit.
- [ ] **Step 5: Deploy that exact Bot source to Cloudflare** without creating a workflow; verify active version/bindings and no temporary diagnostics.
- [ ] **Step 6: Verify Railway/Cloudflare logs** through a fresh New Chat: unbound boot -> probe -> Topic create -> generation rotation -> bound boot -> session.create -> Ready. Require positive deployment/health logs and no pending/failure state.
- [ ] **Step 7: Live Telegram smoke**: Main Panel edits in place; Continue to thread; ReplyKeyboard collapse/reopen; Compact; model change + full capabilities; AI response; native Stop; manual Topic ignored; Delete Chat; fresh New Chat after deletion; Factory Reset reconciliation.
- [ ] **Step 8: If any smoke/log check fails**, return to the owning task, add a regression test first, fix, rerun the full gate, redeploy, and repeat until clean.
- [ ] **Step 9: Record the final Core tag/commit/image digest, Bot commit, Cloudflare version, and Railway health result in the completion report.**
