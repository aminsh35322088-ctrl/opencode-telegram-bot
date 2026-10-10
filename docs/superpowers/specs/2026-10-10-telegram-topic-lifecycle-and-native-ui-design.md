# Telegram Topic Lifecycle and Native UI Design

Date: 2026-10-10
Status: Proposed for implementation after user review
Scope: Cloudflare control plane, Railway topic-worker lifecycle, Telegram Topic UI/routing, native generation presentation, destructive cleanup

## 1. Intent

The bot must return to a simple, reliable Telegram-native interaction model while preserving the newer native Thinking/Stop experience.

The primary goals are:

1. `New Chat` must not create a Telegram AI Topic until its dedicated Railway worker is deployed, healthy, OpenCode is ready, and a provisional OpenCode session has been prepared successfully through the narrow unbound preparation path.
2. The existing Main Panel in `All` must be the single provisioning surface. It is edited in place while a new AI thread is being created and is locked until provisioning succeeds, fails, or is cancelled.
3. Managed AI Topics must use a real Telegram `ReplyKeyboardMarkup` for Topic controls, matching the previously working UX.
4. `All`, managed AI Topics, and manually created Telegram Topics must remain strictly isolated from each other.
5. Telegram's native Stop control must be the only user-facing run cancellation mechanism. Legacy Pause/Resume/Abort features are to be removed rather than retained as fallbacks.
6. Delete Chat and Factory Reset must perform strict, ownership-aware cleanup of Railway and application resources and must fail closed when ownership or cleanup cannot be proven.
7. The implementation is not complete until source tests, deployment checks, Railway health, Cloudflare behavior, and live Telegram smoke tests all pass.

The design deliberately favors a small, explicit lifecycle over pooling or reuse optimizations. A slightly slower fresh-worker creation path is preferable to a complex worker-pool state machine while the bot is being stabilized.

## 2. Current-State Findings That Drive the Design

The current Cloudflare path creates the Telegram Topic before Railway provisioning is complete. The current Railway advance path, in turn, assumes a Topic/thread already exists. This ordering must be inverted, so the allocation state machine requires a real lifecycle change rather than a superficial UI patch.

The repository still contains the previously working Topic ReplyKeyboard builder and keyboard state machinery. The current Cloudflare Topic UI explicitly removes legacy ReplyKeyboards and replaces them with inline controls. The design reuses the proven ReplyKeyboard behavior rather than inventing another control system.

The old Topic creation flow also contains the desired first-message behavior: the first bot-authored message is sent inside the newly created Topic, carries the ReplyKeyboard, and includes a model routing/capability summary. Because that message belongs to the Topic, Telegram can surface it in `All` with its native `Continue to thread` affordance. The design preserves that model.

The current routing path already has an important isolation property: model prompts are accepted only for an active managed Topic that matches a stored `chatId + threadId` binding. Manual Telegram Topics do not have that binding and therefore must remain non-AI surfaces.

Railway destruction already has useful ownership fences: generation checks, DELETING-state requirements, exact managed service-name checks, service/volume association checks, and post-delete inventory verification. Factory Reset will build on those guarantees instead of bypassing them.

## 3. Chosen Architectural Approach

Three approaches were considered:

- Revert only the visible UI to old behavior. This is too shallow because the current provisioning order itself violates the required lifecycle.
- Keep the current control plane and make the lifecycle explicit. This is the chosen approach because it preserves existing boundaries while correcting the state machine and reusing proven old UX.
- Extract a separate provisioning coordinator subsystem. This is cleaner in isolation but introduces unnecessary restructuring during a stability-focused fix.

The chosen architecture keeps the existing Cloudflare control plane, Durable Object/store, Railway driver, and Telegram integration, but introduces an explicit two-stage backend-first allocation lifecycle and strict terminal cleanup rules.

## 4. Scope Model: All vs Managed AI Topic vs Manual Topic

These three scopes are intentionally different and must never blur together.

### 4.1 All / root scope

`All` owns the Main Panel and its InlineKeyboard navigation such as New Chat, History, and Main Settings.

Rules:

- No AI ReplyKeyboard is installed in `All`.
- Ordinary root messages never enter an AI session.
- `New Chat` starts only from the Main Panel.
- While provisioning is active, that same Main Panel message is edited in place and becomes the provisioning display.

### 4.2 Managed AI Topic

A managed AI Topic is one created by the bot only after a backend allocation reaches session-ready state.

Rules:

- It owns exactly one active worker generation and one OpenCode session binding.
- It receives the AI ReplyKeyboard.
- Ordinary messages route to AI only when the stored active Topic binding matches the incoming `chatId + threadId`.
- Native Thinking and native Stop operate only inside this scoped binding.

### 4.3 Manual Telegram Topic

A Topic created manually by the user in Telegram is intentionally ignored by the bot as an AI runtime surface.

Rules:

- No Worker is provisioned.
- No OpenCode session is created.
- No AI ReplyKeyboard is installed.
- No ordinary message is routed to a model.
- Factory Reset and Delete Chat must not delete or mutate manual Topics.

## 5. New Chat Lifecycle

### 5.1 Main Panel locking

When the user presses `New Chat`, the existing Main Panel message in `All` is edited into a locked provisioning view. No second New Chat path is exposed while the operation is in progress.

The panel should present compact, user-readable progress such as:

- Allocating Railway worker
- Creating fresh volume
- Deploying runtime
- Waiting for Railway deployment success
- Waiting for worker health
- Preparing OpenCode
- Preparing OpenCode session
- Creating Telegram Topic
- Binding prepared session
- Ready

The exact copy may be polished, but the panel remains one message edited in place. Provisioning must not spam progress messages into the chat.

### 5.2 Backend-first state machine

The required order is:

`IDLE -> PROVISIONING -> WORKER_HEALTHY -> SESSION_PREPARED -> TOPIC_CREATING -> BINDING -> READY`

A Telegram Topic must not exist before the backend worker is healthy and a provisional OpenCode session has been prepared successfully.

The concrete success path is:

1. Reserve an allocation/job and a fresh worker generation.
2. Create/configure the Railway Service and fresh Volume.
3. Deploy the topic runtime.
4. Verify Railway deployment success.
5. Verify real worker health/readiness and OpenCode readiness while the worker is still unbound (`chatId=0`, `threadId=0`).
6. Invoke one narrowly scoped unbound RPC, `session.prepare`, which creates a provisional OpenCode session and returns only its `sessionId`; ordinary unbound model/session RPC remains forbidden.
7. Allocate the next managed Topic number/title and call Telegram `createForumTopic`.
8. Bind the worker generation to the real `chatId + threadId`, attach the prepared `sessionId`, and close the unbound RPC scope.
9. Persist/finalize the binding containing at least `chatId`, `threadId`, `sessionId`, `workerId`, `generation`, and normalized workspace identity.
10. Send the first Topic-owned Ready/Created message with model capability summary and ReplyKeyboard.
11. Restore the Main Panel in `All` to its normal idle/navigation state.

The provisional `session.prepare` path is a deliberately narrow exception to the normal Topic-scoped RPC boundary. It is valid only for a healthy, unbound worker in the current allocation generation, cannot accept model prompts or arbitrary session operations, and must become unusable as soon as the worker is bound or fenced. No fake or durable placeholder Telegram thread identifier is permitted.

### 5.3 First Topic message and native Continue to thread

The first durable bot-authored message is sent inside the managed AI Topic. It is not duplicated separately into `All`.

The message contains:

- A creation header such as `Chat #01 created`.
- Exact default model identity.
- Model capability/routing summary.
- The Topic ReplyKeyboard.

Because this single message belongs to the Topic, Telegram may surface it in `All` and provide the native `Continue to thread` action. Entering the thread shows the same message because it is the same Telegram message, not a copied notification.

### 5.4 Failure and Retry

Any failure before READY moves the allocation into cleanup instead of attempting to continue from a partially successful intermediate state.

The failure model is:

`<any non-ready state> -> CLEANING -> FAILED_CLEAN -> RETRYABLE`

Rules:

- Partial Service, Volume, runtime, workspace, and session resources are retired as applicable.
- Cleanup is verified before the UI exposes Retry/Cancel as a clean state.
- Retry never resumes a half-built allocation. It creates a fresh attempt with a new generation after cleanup has been verified.
- The same Main Panel is edited into the error view and exposes `Retry` and `Cancel`.
- Cancel returns the Main Panel to idle only after required cleanup has completed or has entered an explicit cleanup-required error state.

No dead Telegram Topic should be created for failures occurring before session readiness.

## 6. Managed Topic ReplyKeyboard

Managed AI Topics use a real Telegram ReplyKeyboard, not a Topic inline control panel.

The normal Topic controls are:

- `Compact: ON` or `Compact: OFF`
- The exact current model name
- `Delete Chat`
- `Topic Settings`

The keyboard is dynamic. Changing model or Compact state must generate a new bot message that carries the updated ReplyKeyboard.

The keyboard must preserve Telegram's native client control for collapsing and reopening the custom keyboard. `is_persistent` must therefore be omitted or false (Telegram documents that the default non-persistent keyboard can be hidden and reopened with the keyboard icon), while `resize_keyboard` may remain enabled. No custom Hide Keyboard button is introduced.

### 6.1 Control-message handling

ReplyKeyboard presses arrive as ordinary user text messages, so they require strict interception.

Required order:

`classify exact control -> delete user's control-text message -> execute control action`

Rules:

- Recognized control text must never enter prompt merging, prompt queues, or model dispatch.
- Dynamic model-name buttons must be recognized from the scoped Topic state, not by broad global string matching.
- Deletion is awaited before action rendering begins, preserving the proven old behavior.
- A final ingress guard must still reject/consume recognized ReplyKeyboard controls if an earlier router fails to do so.

### 6.2 Compact changes

Toggling Compact produces a short normal Topic message such as `Compact: ON` or `Compact: OFF`, and that message carries the refreshed ReplyKeyboard.

### 6.3 Model changes

Changing the model sends the full model capability summary, not merely a one-line "model changed" notice. The exact same formatter/service used for Topic creation should be reused to prevent capability-display drift.

The summary should expose supported routing/capabilities already available in repository metadata, including where applicable:

- Chat
- Vision
- Reasoning
- Tool Call
- Agent Mode
- Voice to Text
- Image AI
- Text to Voice

The summary message carries the refreshed ReplyKeyboard whose model button displays the exact selected model name.

## 7. Native Thinking and Native Stop

### 7.1 Removal of legacy run controls

Pause, Resume, and Abort are no longer product features.

Implementation scope includes removal of user-facing and feature-specific legacy code for:

- ReplyKeyboard buttons
- Inline actions/callbacks
- command handlers
- pause/resume UI state
- dead action routing and menu copy
- tests whose only purpose is the removed UX

Internal cancellation primitives required to terminate a running process/session remain, but they are not exposed as a legacy Abort feature.

### 7.2 Telegram native Stop

Telegram native Stop is the sole user-facing cancellation mechanism during generation.

The incoming `stopped_message_generation` event must resolve the exact current run using scoped identity including Topic and generation. It cancels only the current run belonging to that managed Topic/generation.

A stale stop event must not cancel a new generation, another Topic, or a replacement run.

### 7.3 Thinking presentation

The native Thinking experience is preserved with a presentation refinement.

Threshold:

- Short Thinking: at most 320 characters AND at most 4 lines.
- Long Thinking: more than 320 characters OR more than 4 lines.

Behavior:

- Short completed Thinking remains visible as a normal, non-collapsed blockquote.
- Long Thinking remains fully visible/open while generation is active.
- When long Thinking completes, the same visible content becomes an `expandable_blockquote` so it is compact by default but can be expanded with one tap.

The renderer must preserve existing RTL/mixed-language handling.

## 8. Delete Chat Lifecycle

Delete Chat is destructive and Topic-scoped.

The required ordering is intentionally backend-first so a Telegram Topic is not hidden while expensive resources remain orphaned.

Success path:

`confirm -> fence Topic/generation -> reject new ingress -> cancel current run -> retire OpenCode session/runtime -> destroy Railway Service -> destroy Railway Volume -> verify Railway cleanup -> clear managed binding/state -> delete Telegram Topic`

Rules:

- The Topic is not returned to ACTIVE after destructive fencing begins.
- Service ownership must be proven using stored IDs/generation and managed identity checks.
- Volume ownership/attachment must be proven before deletion.
- Telegram Topic deletion is the final destructive step.
- If cleanup fails, the Topic remains in a cleanup-required/deleting state and cannot accept prompts.
- Retrying cleanup continues cleanup; it does not reactivate the Topic.

No worker pool or reusable Service slot is introduced. Delete Chat removes both the Service and Volume.

## 9. Factory Reset Lifecycle

Factory Reset is a global destructive operation over bot-managed resources only.

The high-level flow is:

`LOCK -> fence managed Topics/jobs -> cancel active runs -> clean pending allocations -> destroy proven-owned Railway resources -> reconcile Railway inventory -> delete managed Telegram Topics -> wipe managed sessions/workspaces/bindings/UI/config -> verify empty managed state -> UNLOCK`

### 9.1 Ownership and fail-closed behavior

Factory Reset must never delete a Railway resource based only on a name that looks managed.

Deletion requires sufficient proof derived from stored worker/job identity and live Railway inventory, such as the expected project/environment, service ID, volume ID, worker ID/generation, managed service naming, and attachment relationships.

If a resource appears suspicious or potentially orphaned but ownership cannot be proven:

- Do not delete it blindly.
- Do not wipe the control-plane evidence needed for later reconciliation.
- Fail Factory Reset with an explicit cleanup/reconciliation-required state.
- Expose Retry for another reconciliation attempt.

This is a fail-closed safety property.

### 9.2 Reconciliation pass

Factory Reset must not rely only on the current in-memory/logical Topic list. It must perform a bounded Railway inventory reconciliation so stale managed records and provider-side leftovers are detected.

The reconciliation pass must distinguish:

- proven-owned resource: safe to clean
- already deleted/provider-purge-pending resource: safe to record as cleaned
- unrelated resource: ignore
- ambiguous resource: stop and fail closed

Railway's delayed purge behavior for deleted detached volumes is acceptable when the provider clearly reports a valid pending-deletion receipt/state. Such a Volume is never reused.

### 9.3 Completion criteria

Factory Reset may show `Completed` only when:

- no managed active/pending Topic remains
- no managed active/pending allocation remains
- no proven-owned live Railway Service remains
- no proven-owned attached live Volume remains
- no managed session/runtime binding remains
- no managed Topic workspace/binding remains
- global bot configuration has been reset as intended

Manual Telegram Topics are explicitly outside the reset scope.

## 10. Concurrency and Fencing

Every lifecycle transition that can cross process/provider boundaries must be generation-scoped and idempotent.

Critical rules:

- Once a worker generation is fenced, callbacks/events from older generations are rejected.
- Delete and Factory Reset close prompt ingress before remote cleanup begins.
- Retry always receives a new generation.
- Native Stop resolves only the active run for the exact current Topic generation.
- Topic creation/binding is single-flight per New Chat allocation.
- Duplicate Telegram updates and retried provider calls must not create duplicate Topics, Services, Volumes, sessions, or bindings.

## 11. Error Handling and User-Facing States

The user should see clear states without implementation detail leakage.

### New Chat

- In progress: edited Main Panel with current provisioning stage.
- Failure after cleanup: edited Main Panel with concise error plus Retry/Cancel.
- Cleanup ambiguity/failure: edited Main Panel reports cleanup required and does not claim a clean retry until safe.
- Success: Main Panel returns to normal; new managed Topic exists and contains its Ready/Created message.

### Delete Chat

- Confirmation remains explicit.
- Once confirmed, the Topic becomes non-writable immediately.
- A cleanup failure must not imply deletion succeeded.

### Factory Reset

- Existing multi-step confirmation remains appropriate.
- During reset, managed lifecycle actions are locked.
- Ambiguous ownership produces reconciliation-required failure, not best-effort deletion.

## 12. Testing Strategy

The implementation must add or update automated coverage for lifecycle, routing, keyboard, native generation, and destructive cleanup.

Required regression groups include:

### 12.1 New Chat state machine

- Telegram Topic is not created before worker health and successful unbound `session.prepare`.
- Unbound workers reject every ordinary session/model RPC; only the exact `session.prepare` preparation operation is allowed in the current allocation generation.
- A stale generation, already-bound worker, or fenced worker cannot use `session.prepare`.
- Worker deploy failure creates no Topic.
- Session preparation failure creates no Topic.
- Topic creation failure retires the prepared session and cleans the already-created backend resources.
- Binding failure deletes the newly created Topic, retires the prepared session, and cleans backend resources.
- Retry begins from a clean state with a new generation.
- Duplicate New Chat update cannot allocate twice.

### 12.2 Scope isolation

- `All` keeps only Main Inline Panel behavior.
- Managed AI Topic receives ReplyKeyboard and AI prompt routing.
- Manual Topic receives neither AI UI nor AI routing.
- No ReplyKeyboard control leaks into `All` behavior.
- A message from one managed Topic cannot dispatch to another Topic's session.

### 12.3 ReplyKeyboard

- Compact label updates ON/OFF correctly.
- Model button uses exact current model name.
- Model change sends full capability summary and refreshed keyboard.
- Control message deletion happens before the action output is rendered.
- Control text never reaches prompt ingress, merger, queue, or model dispatch.

### 12.4 Native generation

- Pause/Resume/Abort user-facing routes no longer exist.
- Native Stop cancels only the exact current run.
- Stale-generation Stop does not affect the replacement run.
- Short Thinking remains open/non-expandable after completion.
- Long Thinking is open while active and expandable after completion.
- Threshold boundaries at 320 chars and 4 lines are tested.

### 12.5 Delete Chat

- Fences ingress before cleanup.
- Cancels current run safely.
- Removes Service and Volume only with ownership proof.
- Verifies provider cleanup state before deleting Telegram Topic.
- Cleanup failure leaves Topic non-writable and retryable for cleanup only.

### 12.6 Factory Reset

- Cleans all proven-owned managed resources.
- Leaves manual Telegram Topics untouched.
- Detects provider-side orphan/leftover resources through reconciliation.
- Ambiguous ownership fails closed and preserves reconciliation evidence.
- Does not report Completed while any managed active/pending resource remains.

## 13. Deployment and Definition of Done

A green unit test suite is necessary but not sufficient.

The required completion sequence is:

1. Lint passes.
2. Typecheck passes.
3. Build passes.
4. Full automated test suite passes.
5. Focused lifecycle/state-machine regression suite passes.
6. Exact GitHub `main` artifact is deployed.
7. Cloudflare deploy/runtime logs show no new control-plane errors for the exercised flows.
8. Railway deployment and worker health are positive for a newly created managed Topic.
9. Live Telegram smoke testing succeeds.

Live Telegram smoke coverage must include at minimum:

- New Chat provisioning panel from start to Ready
- managed Topic creation only after backend readiness
- created-message visibility in Topic and native Continue to thread from All
- AI prompt/response in the managed Topic
- native Stop cancellation
- Compact toggle and dynamic keyboard refresh
- Model change, exact model label, and full capability summary
- Telegram native ReplyKeyboard collapse/reopen control
- manual Telegram Topic ignored
- Delete Chat full backend cleanup followed by Telegram Topic deletion
- another New Chat after deletion
- Factory Reset with verified Railway reconciliation

If any of these fail, implementation is not considered complete; the source must be corrected and the deployment/test cycle repeated.

## 14. Non-Goals

This change does not introduce:

- Railway Service pooling or reuse
- automatic AI provisioning for manually created Telegram Topics
- custom Hide/Show ReplyKeyboard buttons
- legacy Pause/Resume/Abort fallbacks
- a separate new provisioning microservice/subsystem
- unrelated refactoring outside the lifecycle/UI paths required for this design

## 15. Expected Code Areas

Implementation is expected to touch, at minimum, the existing responsibilities represented by:

- `src/cloudflare/control-object.ts`
- `src/cloudflare/control-store.ts`
- `src/cloudflare/railway-fleet-driver.ts`
- `src/cloudflare/bot-ui.ts`
- `src/cloudflare/run-presentation.ts`
- existing Telegram Topic/ReplyKeyboard routing and keyboard helpers
- existing model routing/capability summary service
- Delete Chat / reset paths and their tests

The implementation should reuse the repository's existing keyboard builder, capability formatter/routing summary, generation fencing, and Railway ownership verification wherever they already satisfy the requirements.
