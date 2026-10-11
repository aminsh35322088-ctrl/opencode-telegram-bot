# Railway Deployment

This fork is prepared to run as a **Telegram-first OpenCode service on Railway**.

## Architecture

```text
Telegram
   │
   ▼
Node.js bot (PID 1)
   │
   ├── Telegram Bot API
   │
   └── OpenCode SDK → http://127.0.0.1:4096
                         ▲
                         │
                  OpenCode CLI
                  `opencode serve`
```

The bot starts the local OpenCode server inside the same container when `OPENCODE_AUTO_START_IN_CONTAINER=true`. No public HTTP port is required for the bot itself.

## Required Railway variables

Set these in the Railway service Variables tab:

- `TELEGRAM_BOT_TOKEN` — token from @BotFather
- `TELEGRAM_ALLOWED_USER_ID` — your numeric Telegram user ID
- `OPENCODE_MODEL_PROVIDER` — default model provider
- `OPENCODE_MODEL_ID` — default model ID

The Railway entrypoint supplies these defaults automatically:

- `OPENCODE_API_URL=http://127.0.0.1:4096`
- `OPENCODE_AUTO_RESTART_ENABLED=true`
- `OPENCODE_AUTO_START_IN_CONTAINER=true`
- `OPENCODE_MONITOR_INTERVAL_SEC=60`
- `OPEN_BROWSER_ROOTS=/app/workspace`

If you want to override them, define the variables explicitly in Railway.

## OpenCode authentication

If the OpenCode server should use HTTP Basic Auth, set:

```text
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=<strong-password>
```

The bot reads these values and authenticates its SDK requests automatically.

## Persistent storage

Attach a Railway Volume at:

```text
/data
```

For this fork, `/app/data` is the bot's runtime home. If you use the standard Railway volume mount path `/data`, set the following variables so all persistent state is placed on the volume:

```text
OPENCODE_TELEGRAM_HOME=/data
HOME=/data
XDG_CONFIG_HOME=/data/.config
XDG_DATA_HOME=/data/.local/share
XDG_CACHE_HOME=/data/.cache
```

The repository defaults are optimized for a container-local `/app/data`; for Railway production, a volume-backed path is recommended.

## No public domain is needed

This fork is intentionally Telegram-only. Do **not** create a Railway public domain unless you have a separate reason to expose an HTTP endpoint.

The OpenCode API remains bound to `127.0.0.1:4096` and is not exposed to the Internet.

## OpenCode Telegram Core release pin

Production does not update `opencode-ai` independently. The bot pins one immutable OpenCode Telegram Core release in `core-release.lock.json`; that release owns the compatible OpenCode runtime, SDK, and native Core package as one verified unit.

Railway builds download the locked Core runtime artifact, verify its SHA-256 digest, install the SDK/native packages from the same GitHub Release, and verify all three artifacts report the same Core/upstream identity before compiling the bot.

Upgrades therefore happen only by moving the Core release pin after Core verification. This prevents runtime/SDK/Core drift.

## Resource strategy

The Railway image consumes the prebuilt headless OpenCode runtime from the pinned Core release rather than compiling OpenCode from source or installing a separate npm CLI release.

This removes the large OpenCode source/UI build from Railway and avoids storing build caches in the runtime volume.

Runtime caches and OpenCode state should live on the attached volume when persistence is required. Avoid storing generated build artifacts in `/data`.

## Telegram commands

The upstream bot already provides commands such as:

- `/status`
- `/new`
- `/abort`
- `/detach`
- `/sessions`
- `/messages`
- `/projects`
- `/worktree`
- `/open`
- `/ls`
- `/settings`
- `/rename`
- `/commands`
- `/skills`
- `/mcps`
- `/task`
- `/tasklist`
- `/help`

See the main README for the complete command reference.

## Deploys interrupt live agent sessions

This container runs both the bot and the OpenCode agent runtime. A Railway
deployment is a hard replacement of the container, so:

- Every push or merge to `main` triggers an auto-deploy and `SIGTERM`s the
  running container.
- Any in-flight OpenCode session, agent turn, or tool call is killed at that
  moment. There is no draining of coding sessions; the Telegram reply for the
  aborted turn is simply never sent.

Two consequences when an agent works on tests or CI:

1. **Waiting is invisible.** Long blocking tool calls (CI watchers, test
   suites) emit no Telegram output while running, so a healthy wait can look
   like a hang to chat observers. Agents should prefer short bounded polls
   over one long wait and report between polls.
2. **Pushing to `main` from inside a session kills that session.** If the
   running agent pushes to `main` and then keeps waiting (for CI, for a test
   run, or for user input), the deploy triggered by its own push will abort
   the session mid-wait. Validate on a PR branch, wait for CI, merge last,
   and do not block on long waits right after a direct push to `main`.

The stall watchdog aborts busy sessions that show no progress for a fixed
window, but active tool calls registered through the SSE stream pause that
countdown, so silent long-running tools (test runners, CI waits) no longer
trigger aborts.

### Dynamic Worker provisioning migration

Worker allocation now uses a privileged `WorkerProvisioningDriver`; the Railway
implementation owns GraphQL, its durable resource journal, volume attachment,
minimal identity bootstrap and retirement. `NodeProvisioner` remains an import
alias for compatibility. Topic/control code does not choose Railway resources.

`WORKER_POOL_POLICY` may configure an ordered JSON array of existing eligible
`{projectId, environmentId, region, capacity?}` pools. Omitted capacity delegates
actual resource admission to Railway; configured capacity is a per-project policy
limit. The default discovers the Control project and existing `opencode-topic-*`
projects in the same workspace. New projects are never created automatically.
No slot number selects a project, and there is no four-Worker maximum.

`WORKER_RUNTIME_IMAGE` must be a public immutable image reference ending in
`@sha256:<64 lowercase hex characters>`. New allocations cannot source-build or
fall back to local/shared execution. Without a configured verified image they
fail with `image_unavailable`. The existing Core prerelease workflow publishes
the governed Worker image; the pinned Core commit/version is verified through
signed Worker health before snapshot activation and session creation.

Previously deployed image-less Workers retain their source and volume on a
fenced identity handoff until an explicit image canary migrates them. New Worker
allocations always use an image. Existing persisted slot IDs are legacy identity
metadata, not capacity or placement policy. Startup reconciles persisted Workers
and does not manufacture four warm reservations. An explicit `WORKER_WARM_CAPACITY`
can reserve a small administrative validation/warm pool; its default is zero.

Capacity exhaustion is `capacity_exhausted` (`NO WORKER AVAILABLE / CAPACITY
EXHAUSTED`). Definitive Railway resource-limit rejections roll over only unused
provisioning resources; deployed/handoff Workers are never deleted for placement.
Transport ambiguity is reconciled by deterministic service identity. If a bare
volume-create response is lost, `reconciliation_required` prevents another volume
create and prevents claiming retirement until ownership is recovered. Known
service/volume partial provisioning resumes from the journal on retry/restart.

The remaining four-stream and four-inflight-IPC bounds are simultaneous request
budgets; they do not limit the number of Topics, Workers or Railway projects.
The old four-slot tests now use an explicit warm-capacity fixture to retain
migration/security regression coverage.

New Chat uses a durable request receipt keyed by the Telegram update identity.
Concurrent duplicate calls share one flight. Restart retries reuse a recorded
Forum Topic and Worker generation; an unknown Forum-create result requires
reconciliation instead of creating another Topic. Completed receipts cannot
resurrect a deleted/reset Worker generation. Explicitly reducing the warm target
fences and retires unused pending reservations without removing ready Workers.
