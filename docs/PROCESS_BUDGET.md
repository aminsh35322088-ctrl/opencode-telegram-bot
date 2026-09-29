# Railway Process Budget Policy

Production runs inside a constrained Railway service. Every child process started by the bot must be admitted through `src/runtime/process-budget.ts`. Raw `spawn`, `exec`, `execFile`, or `Bun.spawn` calls are forbidden outside that registry and CI enforces the rule.

## Service envelope

The governor reads Linux cgroup v2 memory and CPU limits at runtime. Railway is the source of truth when those files are present; `BOT_PROCESS_MEMORY_LIMIT_MB` is only a fallback for environments without a cgroup memory limit.

Admission is fail-closed when the predicted footprint would cross a category pressure ceiling. New work also carries a five-second warm reservation so concurrent process starts cannot overbook memory before cgroup accounting catches up.

| Kind | Max active | Reserved RAM | Pressure ceiling | Lifetime / timeout |
| --- | ---: | ---: | ---: | --- |
| OpenCode server | 1 | 256 MiB | 98% | owner-bound |
| Bot daemon | 1 | 192 MiB | 98% | owner-bound |
| Local MCP server | 1 | 96 MiB | 94% | 2 h maximum |
| ffmpeg media work | 1 | 96 MiB | 94% | 90 s maximum |
| ffprobe | 1 | 24 MiB | 95% | 15 s maximum |
| SSH/SCP | 2 | 24 MiB each | 97% | 10 min maximum |
| ssh-keygen | 1 | 24 MiB | 96% | 20 s maximum |
| Tailscale CLI | 2 | 24 MiB each | 97% | 30 s maximum |
| Git/worktree | 1 | 48 MiB | 95% | 45 s maximum |
| Diagnostics | 2 | 12 MiB each | 98.5% | 10 s maximum |
| Cleanup / termination | 8 | 8 MiB each | recovery lane | 10 s maximum |
| Version probes | 2 | 12 MiB each | 95% | 5 s maximum |

A global default ceiling of seven admitted child processes applies across normal work categories. `BOT_PROCESS_MAX_ACTIVE` can lower or raise it when a deployment envelope changes. The bounded `cleanup` recovery lane is deliberately exempt from the normal global and memory admission gates so an overloaded service can still terminate stale processes; it remains capped at eight concurrent cleanup commands with a 10-second maximum lifetime.

Container infrastructure that exists before the Node bot starts is treated as baseline rather than lease-admitted work. In production this includes `dumb-init` and the single shared `tailscaled` daemon started by `railway-entrypoint.sh`. The daemon is explicitly bounded with `GOMAXPROCS=1`, `GOMEMLIMIT=160MiB`, one instance only, and the existing 10-second socket-readiness deadline. Bootstrap repository clone/fetch/reconcile commands are serialized before application startup and each network/reconcile phase is bounded by `BOOTSTRAP_GIT_TIMEOUT_SEC` (120 seconds by default). Startup version/toolchain probes are bounded independently by `BOOTSTRAP_PROBE_TIMEOUT_SEC` (5 seconds by default), so a broken CLI cannot stall service boot. Their memory is still part of `memory.current`, so every later admission pays for it. The watchdog also reports `serviceProcessCount` from `cgroup.procs`, ensuring baseline and nested descendants remain visible in service-level accounting even when they are not direct registry children.

## In-process workload budgets

Not every expensive unit is an OS process. Telegram Core treats these as resource-budgeted workloads too:

| Workload | Default rule | Pressure / failure behavior |
| --- | --- | --- |
| TopicWorker | Hard cap from `railwayPolicy.maxWorkers`; one worker per admitted binding | At soft RSS pressure, evict the oldest idle worker or reject new work; at hard RSS, emergency shutdown. General/ALL never receives a worker. |
| Sub-Agent | 4 active children per parent, 6 globally, max 24 active/queued per parent | Rolling admission; each active child has a 20-minute execution deadline; one child failure does not cancel healthy siblings. |
| Scheduled task | Reuses the same binding/worker admission path | Unbound/stale bindings fail closed; durable execution IDs suppress duplicates. |
| Telegram API request | Normal calls receive bounded deadlines | Long-poll `getUpdates` is the deliberate exception so polling can remain open without being mistaken for a stuck request. |

These Core workload budgets become production-active with the Telegram Core runtime migration. Until then, the Bot-side cgroup governor still sees their aggregate memory/CPU through the OpenCode process.

## OpenCode child processes

When the bot starts OpenCode it sets `OPENCODE_TELEGRAM_PROCESS_BUDGET=1`. When the Telegram Core runtime is mounted into the bot, that flag activates a second governor inside OpenCode for shell commands, local MCP stdio servers, LSPs, PTYs, git/ripgrep utilities, and helper/install processes. The internal default global ceiling is four children and can be tuned with `OPENCODE_TELEGRAM_CHILD_MAX_ACTIVE`.

The current production image still installs the upstream npm OpenCode build, so that build ignores the Telegram Core-only flag. Until the Core runtime migration is completed, nested OpenCode descendants are visible and charged through cgroup `memory.current` and `serviceProcessCount`, but they do not yet receive individual category leases. Do not claim per-child OpenCode enforcement is active in production until the runtime source has been switched to Telegram Core.

## Pressure behavior

- Admission is denied before a process starts when memory headroom is insufficient.
- Existing critical processes are not killed merely because pressure rises; the watchdog emits warnings at 88% and critical logs at 95%.
- Short-lived work gets bounded timeouts. Long-lived owner-bound services must release their lease on exit/close.
- Command arguments and environment secrets are never emitted by the budget logger. Logs contain only process kind, lease id, duration, counts, cgroup memory, and CPU limit.
- A rejected process must surface as a controlled operation failure; callers must not retry in a tight loop.

## Development rule

Any new code path that starts an OS process must first add or reuse an explicit process kind and route through the budget registry. If a new class of process has materially different RAM, concurrency, or lifetime behavior, add a dedicated rule and tests rather than reusing an unrelated category.
