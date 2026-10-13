# OpenCode Telegram Bot

OpenCode Telegram Bot lets an authorized Telegram user run persistent OpenCode coding sessions from chats and Forum Topics. It provides the Telegram interface, product workflows, settings, and infrastructure control plane. OpenCode Telegram Core provides the pinned OpenCode runtime and the execution primitives used by the bot.

The bot is designed so a Telegram Topic is a durable, isolated work context: messages, session state, settings, events, files, and runtime ownership resolve to that Topic instead of relying on whichever chat happened to be active most recently.

## What the system does

- Runs OpenCode coding sessions through Telegram, including streamed responses, tool activity, questions, permissions, cancellation, and status.
- Creates Telegram Forum Topics for separate coding conversations and restores their session/workspace association after restart.
- Provisions and manages Railway Workers for Topics. The Control Plane owns Telegram polling and Railway credentials; each Worker owns one Topic's OpenCode runtime and persistent workspace.
- Provides model selection, provider setup, coding tools, integrations, memory, history, scheduled tasks, and image/audio workflows.
- Keeps authorization, credential handling, routing, process limits, and cleanup explicit so a failed setup does not silently send work to another Topic or runtime.

## Architecture and responsibilities

~~~text
Telegram
   │ Bot API updates and replies
   ▼
Bot Control Plane ───────── Railway API
   │ signed, authenticated node protocol
   ├─────────────────┬───────────────────┐
   ▼                 ▼                   ▼
Topic Worker      Topic Worker        Topic Worker
one Topic         one Topic           one Topic
   │                 │                   │
   └──── pinned OpenCode Telegram Core runtime ────┘
       private OpenCode API + isolated state/volume
~~~

| Part | Main responsibility | Why it exists |
|---|---|---|
| Telegram Bot API and UI (src/bot) | Commands, keyboards, menus, callbacks, message handlers, localized text, and streamed output | Gives the user a coherent Telegram-native interface |
| Product/application layer (src/app) | Sessions, Topic bindings, settings, model/provider catalogs, files, memory, integrations, scheduled work, interaction state, and formatting | Implements user-facing behavior without putting it in infrastructure adapters |
| Control Plane (src/control-plane) | Actor identity, durable request receipts, node bindings, signed node protocol, dispatch, and remote Topic lifecycle | Keeps Telegram authority and infrastructure control in one trusted service |
| Railway adapters (src/infrastructure) | Railway API access, provisioning journal, Worker/project/volume allocation, health checks, canaries, and pool policy | Converts Control Plane decisions into recoverable Railway operations |
| OpenCode adapter (src/opencode) | Local-mode SDK access, process/ready lifecycle, events, restart policy, and managed runtime config | Keeps the bot's product layer independent of OpenCode transport details |
| Core adapter (src/core) | Native Core API, release identity, and compatibility types | Verifies and consumes the pinned Core package as one unit |
| Runtime (src/runtime) | Startup mode, filesystem paths, child environment, and process budget | Makes startup and process/resource policy consistent across supported modes |
| Utilities (src/utils) | Logging, safe error formatting, Telegram rate-limit retries, topic context, and observability | Shares safe operational behavior without leaking internal errors to users |
| Telegram Core | OpenCode runtime, per-binding execution, isolation, streaming/rendering, scheduling, and resource governance | Owns runtime correctness that must be shared and tested as a versioned unit |
| Topic Worker agent (opencode-telegram-core/worker) | Authenticated Worker gateway, identity bootstrap, credential mediation, and narrow runtime bridges | Gives the Control Plane a constrained remote boundary without exposing OpenCode publicly |

The primary production topology is Control Plane plus per-Topic Workers on Railway. Local/single-process mode also exists for development and explicitly configured deployments; it does not provision distributed Workers. Runtime mode selection is implemented by src/runtime/mode.ts and startup is composed in src/app/bootstrap/start-bot-app.ts.

The source folders are further divided by responsibility:

| Folder | What belongs there | Purpose |
|---|---|---|
| src/app/bootstrap | Startup and shutdown composition | Loads durable settings, performs migrations/reconciliation, and starts the selected runtime |
| src/app/services | Product operations and domain workflows | Implements session, Topic, model, provider, memory, file, integration, and task behavior |
| src/app/stores | Durable settings, Topic state, and scheduled-task records | Keeps persisted state behind explicit storage contracts |
| src/app/managers | Short-lived run, permission, question, queue, and interaction state | Coordinates concurrent Telegram/OpenCode interactions without mixing them with persistence |
| src/app/formatters and src/app/types | Telegram-safe output and shared domain shapes | Keeps presentation and typed application boundaries consistent |
| src/bot/commands and src/bot/handlers | User commands and inbound Telegram updates | Converts Telegram input into application operations |
| src/bot/routers, callbacks, menus, and keyboards | Update routing and interactive navigation | Keeps the right control and response in the right Telegram context |
| src/bot/middleware and src/bot/services | Authorization/context middleware and Telegram-specific adapters | Adds per-update policy and bridges product operations to Telegram APIs |
| src/bot/streaming, render, messages, and pinned | Incremental output, message formatting, delivery, and persistent keyboard | Delivers long-running work within Telegram's message model and limits |
| src/control-plane | Actor, global mutation, node registry/protocol, dispatch, and lifecycle contracts | Isolates infrastructure authority from user-facing handlers |
| src/infrastructure | Railway API/provisioning, worker pool and transport adapters | Contains external infrastructure-specific behavior and recovery |
| src/opencode | OpenCode SDK/process/event lifecycle | Isolates local runtime operations used in single-process mode |
| src/core | Native runtime bridge and version/contract types | Connects application code to the pinned Core release |
| src/runtime and src/utils | Startup policy, paths, process budget, logging, error handling, and diagnostics | Provides shared runtime foundations and safe operations |

### Topic identity and isolation

A Topic is identified by its Telegram chat and thread and bound to a session, workspace, Worker identity, and generation. New requests resolve that binding before acting. Event subscriptions and replies keep the explicit chat/thread context. A stale or ambiguous binding must fail closed rather than guessing.

Topic deletion and Worker reuse are lifecycle operations: work is stopped, owned session/process/stream state is cleaned, the next identity generation is installed, and only a proven clean Worker can become available again. If cleanup or provisioning outcome is uncertain, the resource stays fenced for reconciliation instead of being treated as free.

### What happens when the user presses New Chat

The New Chat action (src/bot/commands/new-command.ts, reached from the persistent keyboard) performs one ordered lifecycle:

1. Verify that Railway infrastructure setup is available.
2. Create a candidate workspace and submit an idempotent remote-session request keyed to the Telegram update.
3. Reuse the same request receipt after a retry/restart; do not create another Topic when the result of Telegram's Topic creation is unknown.
4. Ask the Worker/Core runtime to create or recover the OpenCode session, then bind the session to the exact Telegram Topic and Worker generation.
5. Initialize Topic settings, keyboard, event routing, session cache, and attachment.
6. Send the ready message inside that Topic.

If any step fails, the bot reports a user-safe error and attempts compensating cleanup for resources created by that attempt. A capacity limit is a capacity condition, not a generic OpenCode failure. The command must never report success for a Topic that has no usable session route.

## Railway setup and capacity

The Railway Control Plane is the only Telegram-facing service and the only service that needs Railway API access. A Worker does not receive the bot token or Railway provisioning token. The OpenCode API remains private to the Worker; Control Plane traffic uses the signed node protocol.

Required Control Plane variables:

| Variable | Purpose |
|---|---|
| TELEGRAM_BOT_TOKEN | Bot API authentication |
| TELEGRAM_USER_ID | Allowlist for the user who may operate this bot |
| RAILWAY_API_TOKEN | Privileged Railway provisioning, stored/used at the Control Plane boundary |

Attach a persistent volume to the Control Plane at /data. Each Worker also gets its own /data volume. Control state and integrations belong to the Control Plane volume; Topic session and workspace state belong to that Topic's Worker volume.

Worker policy is managed in Main Settings → Railway. The default warm capacity target is five Workers, and the default per-project Worker limit is five. The allocator can create deterministic opencode-topic-NN projects in the selected workspace when the configured project limit or a definitive Railway resource limit prevents another allocation. A Free-plan resource rejection can reduce available capacity; the setup flow reports that limit and offers an explicit “Continue with limited resources” action when at least one Worker is verified healthy. The regular Continue action remains available after all five Workers are ready.

Provisioning is journaled and reconciled. Service/volume partial work resumes from known state; uncertain create/delete outcomes require inventory reconciliation. Deployed or in-use Workers are not deleted just to make room for placement. A new Worker requires a verified immutable runtime image and a successful identity/readiness canary. See Railway operations (docs/RAILWAY.md) and Control Plane security (docs/CONTROL_PLANE_SECURITY.md).

## Telegram features

### Chats, Topics, and sessions

- New Chat creates a Topic-bound coding session.
- History lists recent sessions and offers a bounded preview and continue action.
- /messages, /session, /rename, /detach, and /status operate on the current authorized context.
- Topic settings are kept separate from Main settings where the choice is context-specific.
- Duplicate Telegram updates are idempotent; asynchronous OpenCode events are sent only to their owning session and Topic.

### Models and providers

Model Center is the user-facing model selection point. It supports catalog/provider browsing, search, favorites, recent models, model capability checks, and model routing.

Custom OpenAI-compatible providers are configured from Settings. The bot validates the endpoint/key, discovers models from /models, stores credentials in the managed credential store, and materializes OpenCode configuration. Custom-model tool calling remains disabled until that exact model passes a real tool-call probe. See Custom providers (docs/CUSTOM_PROVIDERS.md).

### Coding tools and integrations

The bot exposes OpenCode skills, MCP servers, custom commands, project/directory selection, Git worktrees, file browsing/downloading, shell and DevOps tools, GitHub, and optional Tailscale/SSH workflows. Each tool uses the active Topic's runtime/workspace context. SSH authorization and workspace state are Topic-scoped.

### Memory, automation, and media

- Persistent memory is model-independent and stores only bounded context for later prompts.
- Scheduled tasks dispatch through the runtime and deliver results to their owning chat/Topic.
- Voice/audio input can be transcribed when an STT provider is configured.
- Image Chat creates a dedicated image Topic with bounded conversation metadata and Telegram file references. Coding Topics can still understand incoming images. See Image Chat (docs/IMAGE_CHATS.md) and media workflows (docs/MEDIA_AI.md).
- Request usage, background runs, and tool activity are tracked so the bot can report state and enforce budgets.

## Commands

| Command | Purpose |
|---|---|
| /start, /help | Start the bot and show help |
| New Chat (persistent keyboard) | Create a Topic and OpenCode session |
| /status | Show server/runtime and current session state |
| /session | Open the session dashboard for the current chat |
| /detach | Stop delivering to the current chat without deleting the session |
| /messages | Browse session messages and supported history actions |
| /open, /ls | Select project folders and browse/download files |
| /worktree | Select or manage Git worktrees |
| /rename | Rename the active session |
| /settings, /providers | Configure behavior and AI providers |
| /commands, /skills, /mcps | Browse OpenCode commands, skills, and MCP servers |
| /task, /tasklist | Create and manage scheduled tasks |
| /opencode_start, /opencode_stop | Control a local-mode OpenCode server where enabled |

The persistent keyboard exposes the most common actions; Settings contains less frequent controls.

### Execution control: Telegram Stop only

The bot exposes exactly one execution control, and it is the Stop button Telegram itself renders on a message the bot is generating. There are no Pause, Resume, or Abort commands, buttons, or keyboard entries, and none may be reintroduced: the product owner removed them, and internal cancellation/cleanup primitives do not authorise a user-facing control.

Telegram Stop cancels the generation draft the user actually stopped:

- It cancels the model execution and the work that depends on it for that exact run, stops late output from it, and releases that run's resources per the Core contract.
- It never cancels another Topic's run, and it never cancels a newer run of the same Topic: a Stop is attributed to the stopped draft first and is refused as a stale draft when the draft does not belong to the run that is still active.
- It never deletes the session or its history, and it never detaches the Worker from the Topic.
- The same Topic stays usable for the next message once the Stop completes.

Telegram Stop is not a pause. A stopped run cannot be resumed; send a new message to start a new run. A Stop is also never acknowledged as success unless cancellation was actually confirmed.

## Configuration

The deployed Control Plane requires the three variables above. Local development starts from .env.example. Common optional operational variables include:

| Variable | Default | Purpose |
|---|---:|---|
| BOT_LOCALE | en | Default bot language |
| LOG_LEVEL | info | Log verbosity (debug, info, warn, error) |
| LOG_RETENTION | 10 | Rotated log file count |
| LOG_MAX_MB | 12 | Maximum size per log file |
| LOG_MAX_TOTAL_MB | 80 | Maximum total log storage |
| BOT_PROCESS_MAX_ACTIVE | runtime policy | Global Bot child-process concurrency ceiling |
| BOT_PROCESS_MEMORY_LIMIT_MB | runtime policy | Process-budget memory envelope |
| OPENCODE_TELEGRAM_CHILD_MAX_ACTIVE | runtime policy | Child concurrency limit when Core process governance is enabled |

Many user settings (model, provider, STT/image configuration, list sizes, formatting, and Worker pool policy) are managed in Telegram and persisted to the appropriate volume. Worker-specific values are bootstrapped by the Control Plane; do not manually copy the Telegram or Railway credentials into Worker services.

## Development and verification

Requirements: Node.js 22.14+ and npm. The Core release is pinned in core-release.lock.json; do not install a separate OpenCode CLI to replace it.

~~~bash
npm ci
npm run build
npm run typecheck
npm run lint
npm install --no-save --package-lock=false vitest@3.2.4
node --import tsx --test tests/main-reply-keyboard.test.ts
node --import tsx --test tests/*.test.ts
npm start
~~~

The root tests cover Main keyboard behavior and Core/control-plane routing. The broader Bot suite lives under .github/ci-tests/tests and is run in CI with Vitest. The workflow materializes that CI-only tree under tests/, where the vitest config expects it, and removes it afterward; run that workflow or use a disposable clean checkout rather than copying it over an existing tests/ tree in a working checkout. For physical Telegram Web checks, see [.github/ci-tests/e2e/README.md](.github/ci-tests/e2e/README.md). Before a release, verify the relevant suite, the pinned Core artifacts, Worker readiness, and the deployed Control Plane/Worker health.

## Security and operational rules

- Restrict bot access with TELEGRAM_USER_ID; protect TELEGRAM_BOT_TOKEN.
- Keep Railway provisioning credentials at the Control Plane boundary.
- Never log or display provider keys, authorization headers, or secret lease material.
- Do not expose the OpenCode API publicly. Only the authenticated Worker gateway is reachable by the Control Plane.
- Resolve chat, thread, session, Worker identity, and generation before dispatching work or replies.
- Treat uncertain provisioning/cleanup as unavailable until reconciled; do not turn it into a healthy green state.
- Every Bot-owned OS child process must use the process-budget registry. See process budgets (docs/PROCESS_BUDGET.md).

## Related documentation

- Railway deployment, pool policy, and troubleshooting (docs/RAILWAY.md)
- Topic isolation architecture (docs/TOPIC_ISOLATION_ARCHITECTURE.md)
- Distributed Topic delivery (docs/DISTRIBUTED_TOPIC_DELIVERY.md)
- Control Plane security (docs/CONTROL_PLANE_SECURITY.md)
- Coding tool catalog (docs/CODING_TOOLS.md)
- Localization guide (docs/LOCALIZATION_GUIDE.md)
- Core runtime and release model (https://github.com/aminsh35322088-ctrl/opencode-telegram-core#readme)

## Behavioral contracts for AI contributors

This section describes the expected user-visible result, not just the current implementation. Use it when fixing a bug or changing a feature. A test that captures a bug is evidence of the regression to prevent; it does not make the bug's current behavior the intended product behavior.

| Area | Expected behavior | When it fails | Starting points |
|---|---|---|---|
| Authorization and update intake | Only the configured Telegram user can cause product actions. Updates received while the Bot was offline must not unexpectedly replay as new commands. | Reject safely, do not execute partially authorized work, and do not reveal private state. | src/bot/middleware, src/bot/routers, .github/ci-tests/tests/bot/routers |
| First-run Railway setup | Validate the Account/Workspace token, show accessible workspaces, bind the selected workspace, and keep provisioning authority in the Control Plane. Never ask for a Project token as a substitute for the required account/workspace scope. | Explain the exact actionable class: invalid credential, access/scope, transport, policy capacity, Railway resource quota, readiness, or reconciliation. Never show a generic green completion when prerequisites are missing. | docs/RAILWAY.md; tests/railway-telegram-onboarding-contract.test.ts; tests/railway-bootstrap-ux.test.ts |
| Five-Worker bootstrap | Keep the configured default target at five. Report actual project, Worker, volume, deployment, and health progress. A definitive Railway resource limit may offer “Continue with limited resources” only when at least one Worker is verified healthy; the user must choose it. Ordinary Continue requires all five. | Do not classify a policy limit, bad image, failed security check, transport error, or unknown resource ownership as a Free-plan quota. Preserve the target and allow retry/reconciliation. | src/bot/commands/railway-onboarding-command.ts; src/infrastructure/railway-worker-settings.ts; tests/railway-limited-continue.test.ts; tests/railway-main-settings-contract.test.ts |
| Main chat and panel | Main chat owns root navigation, setup, settings, and Worker-pool controls. Coding work is sent in a bound Topic; never pick an arbitrary Worker when no Topic binding exists. Once normal or limited setup is explicitly completed, the root panel remains usable to create/manage Topics and change settings. | Keep setup incomplete when the user has not chosen Continue. If no verified Worker exists, do not open a coding Topic or claim the panel has usable execution capacity. | src/bot/commands/railway-onboarding-command.ts; src/bot/routers; tests/railway-limited-continue.test.ts; .github/ci-tests/tests/bot/commands/new.test.ts |
| New Chat | One Telegram update creates or reuses one operation receipt, one Forum Topic, one exact Worker generation, one workspace/session binding, and a working delivery route. Send the ready message inside that Topic only after its session route is usable. | If creation is ambiguous, reconcile/reuse the receipt; do not create duplicate Topics. If a later step fails, clean resources owned by that attempt or leave uncertain resources fenced for reconciliation. Reply with a truthful, user-safe error. | src/bot/commands/new-command.ts; src/control-plane/topic-node-lifecycle.ts; .github/ci-tests/tests/bot/commands/new.test.ts; tests/core-topic-node-lifecycle.test.ts |
| Topic routing and settings | Every prompt, callback, permission/question response, event, keyboard, and file action resolves the current chat/thread/session binding. Topic settings and interaction state must not bleed into Main or another Topic. | Reject stale, missing, or ambiguous bindings; never guess a destination or fall back to another Topic's session. | docs/TOPIC_ISOLATION_ARCHITECTURE.md; .github/ci-tests/tests/app/services/topic-runtime-context.isolation.test.ts; .github/ci-tests/tests/bot/routers/private-main-topic-routing.test.ts |
| Run, question, permission, Telegram Stop, and detach | Controls target the exact active session/run. Telegram Stop cancels only the run that produced the stopped draft and is refused when that draft belongs to another generation; detach stops delivery without deleting its session. Questions and permission prompts resume only the owning run after a valid answer. | A timeout or lost acknowledgment is not success. Reconcile status or report uncertainty; do not silently target a newer run. | src/app/managers; src/app/services/current-run-cancellation-service.ts; tests/native-stop-attribution.test.ts; .github/ci-tests/tests/app/services/session-error-recovery-service.test.ts |
| Session deletion and Worker reuse | Delete removes the Topic's binding and owned session/workspace state, then permits reuse only after cleanup and generation rotation are proven complete. | Partial/uncertain cleanup stays unavailable and is reported/reconciled. Never erase another Topic's state or recycle a Worker based only on HTTP liveness. | src/app/services/telegram-topic-delete-service.ts; .github/ci-tests/tests/app/services/telegram-topic-delete-service.test.ts; docs/DISTRIBUTED_TOPIC_DELIVERY.md |
| Models and providers | Model Center is the single model-selection interface. Route only to models that satisfy the selected capability. A fallback is visible to the user. Custom provider secrets remain private; custom-model tool calling stays disabled until that exact model passes a real probe. | Do not claim tool support based on a different model/provider or silently keep an unavailable selection. Preserve credentials and report a clear setup/eligibility error. | docs/CUSTOM_PROVIDERS.md; .github/ci-tests/tests/app/services/model-capability-routing-service.test.ts; .github/ci-tests/tests/app/services/model-selection-custom-provider-verification.test.ts |
| MCP, extensions, GitHub, and SSH | Each operation uses the active Topic's authorization and workspace. Secrets are leased only for the operation that needs them. SSH approval is bound to the Topic and stable server/user/port identity. | Do not copy credentials into prompts/config/logs, reuse another Topic's lease/workspace, or broaden a capability after a failed check. | AGENTS.md; docs/CONTROL_PLANE_SECURITY.md; .github/ci-tests/tests/app/services/mcp-credential-store.test.ts; .github/ci-tests/tests/app/services/ssh-service.test.ts |
| Output, localization, and streaming | Stream useful progress without flooding Telegram. Respect Telegram entity/length limits, preserve code, keep mixed Persian/English readable, and use the active locale for Bot-authored text. | On Telegram rate limits, retry according to the bounded policy. On formatting failure, use a safe fallback that preserves the response instead of dropping it. | docs/LOCALIZATION_GUIDE.md; .github/ci-tests/tests/bot/streaming; .github/ci-tests/tests/bot/messages |
| Memory, scheduled tasks, and media | Memory is bounded and independent of model choice. Scheduled results return to their owning chat/Topic. Image Chat keeps its own image workflow/state; coding Topics continue to accept image understanding. | Enforce configured size/time/resource bounds, make duplicate scheduling/update delivery idempotent, and never deliver results to a different context. | docs/IMAGE_CHATS.md; docs/MEDIA_AI.md; .github/ci-tests/tests/app/services/scheduled-task-runtime-service.test.ts; .github/ci-tests/tests/app/services/image-action-service.test.ts |
| Process and persistence | Persist only to the correct Control Plane or Worker volume. Every Bot child process goes through the process-budget registry. Secrets and transient leases do not become ordinary durable state. | Budget rejection is a real rejection; do not retry outside the governor. Treat a missing/corrupt state file as a recovery case, not permission to overwrite unrelated data. | docs/PROCESS_BUDGET.md; src/runtime/process-budget.ts; .github/ci-tests/tests/runtime/process-budget.test.ts |

### How another AI should make a change

1. Read AGENTS.md first, then this README and the linked contract for the affected feature. Confirm whether the request is a Bot/UI policy, Control Plane, Railway adapter, Worker, or Core runtime change.
2. Translate the user's request into the observable success state and failure state. The user's explicit request is the product requirement for the task. This README and linked design docs describe existing invariants; focused tests show regressions the project already guards against. Source code is the implementation, not proof that its current behavior is correct.
3. Trace the complete path from Telegram update to service/adapter and back to the Telegram response. Identify every durable write and external side effect before changing it.
4. Reproduce the reported issue and add or update a focused regression test. Do not “fix” a visible error by swallowing it, skipping a health/security check, fabricating progress, or routing work through a shared fallback.
5. Preserve the ownership boundaries above. If a request intentionally changes one, update the contract and its tests in the same change.
6. Run the focused tests, then the relevant typecheck/build/lint gates. For a Telegram-visible flow, add the physical e2e check when a unit test cannot prove Telegram behavior.
7. Report what the user will observe, what was changed, and the exact verification run. If the request conflicts with a security or ownership invariant, explain the conflict and ask before weakening that invariant.

## Project state

The Bot and Core are actively developed together but released separately. The exact Core runtime, SDK, and native-runtime versions consumed by this Bot are recorded in core-release.lock.json. That lock currently pins v1.18.33-bot.13-pre.34; prerelease status and remaining Core release gates are documented in the Core repository. README feature descriptions are a map of intended/current product behavior; deployment health and the running release remain the operational source of truth.
