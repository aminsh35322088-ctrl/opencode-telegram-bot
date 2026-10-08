# Cloudflare control-plane deployment status

Production target: `opencode-control-plane` at `https://opencode-control-plane.amin3532.workers.dev`. `wrangler.jsonc` is the source-controlled configuration. Deploy with existing credentials and `wrangler deploy --keep-vars`; preserve dashboard secrets and admission configuration. No additional GitHub Actions workflow is required.

Cloudflare owns SQLite registry/schema migrations, Topic ownership, provisioning journal, revisioned configuration, bootstrap consumption, encrypted node credentials, signed dispatch and callback admission. Railway provisioning is isolated behind `RailwayFleetDriver`. The default backend reads the Railway credential exclusively from `env.RAILWAY_API_TOKEN`; durable storage contains a binding reference, never the Railway token.

The configured production policy is 10 Workers across at most 2 lazily created projects, 5 Workers per project. There is no pre-provisioned fleet or independent Topic limit. General is not writable. Topic reservations are transactional and idempotent. Topic activation requires signed runtime health/version verification and a Core session. Signed callbacks fence node/generation/Topic/session/run and persist receipts before acknowledgement. Telegram final delivery uses the existing native block/RTL renderer with per-chunk durable delivery receipts.

Deletion fences first. This integration currently destroys the service and volume, verifies service deletion and volume deletion acknowledgement before releasing compute capacity. Railway retains deleted detached volumes for up to 48 hours; the provider purge timestamp is kept in the Worker audit record, and that Worker/volume is never reused. Safe production reuse is intentionally unavailable until Core cleanup/rebind is proven. Existing lower-level reuse tests are not a deployed reuse canary. Ambiguous Telegram delivery and lost bootstrap admission stop with explicit reconciliation state; they do not silently duplicate messages or provision another Worker. Bootstrap readiness has a 20-minute deadline.

## Activation gate

`PROVISIONING_ENABLED=true` enables a single canary against the verified pre.23 immutable image. Runtime, SDK, and image Core identity are pinned as one compatibility unit. Core enforces the admitted configuration revision, ignores stale idle callbacks before a new turn starts, and uses the production headless provider catalog. Core pre.23 serializes the shared SQLite boundary connection and only clears the exact acknowledged pending callback, preserving a newer terminal event. The workspace began with zero live projects; the canary created one owned project automatically. Deleted Railway project/service tombstones are excluded from capacity inventory. A real canary against this image completed model execution and a governed shell/Python tool call, with signed response events and Telegram delivery receipts. Provisioning remains lazy; the temporary canary Worker and Topic were destroyed after validation.


Telegram webhook connection and a real image-based Worker bootstrap/session binding are verified. Authenticated inspection confirms the existing zero-cost `opencode/big-pickle` model is connected and available without new credentials. The first real model run failed safely due to the Core transaction race. After the Core fixes, both `OPENCODE_CF_RAILWAY_CANARY_OK` and the governed tool output `CORE_GOVERNED_TOOL_OK` were produced on Railway and delivered to Telegram. The successful test used the authenticated Control Plane canary endpoint; a real incoming user prompt through the webhook has not been observed. Worker reuse, live project rollover, sleeping wake, automated replacement recovery, and Settings/Models/Questions/Actions/Extensions/MCP/Skills/Plugins UI parity are not claimed complete. The source retains the older Node Bot control path until its replacement is tested; no Railway-hosted Bot/Control service is recreated.

Local verification is recorded in the task evidence report. Unit tests and a deployed `/health` endpoint do not constitute Telegram -> Cloudflare -> Railway -> OpenCode -> Telegram acceptance.

## Direct connector deployment

After uploading a Worker bundle through the Cloudflare API, explicitly activate the returned version at 100% using the deployments API. Verify both `/health` and authenticated `/admin/runtime`; an uploaded bundle alone is insufficient evidence that the Durable Object serves the new code. Preserve `secret_text` and admission bindings throughout deployment. Never export secret values.

The supplied canary chat `1802392273` is a Telegram private chat. Live Telegram metadata confirms that this bot has private Topics enabled; no group-ID conversion is required. The canonical canary model is `opencode/big-pickle`; execution requires an authenticated Core model-catalog preflight and never invents provider credentials.

The protected `/admin/run-status` endpoint exposes scoped run and delivery receipt states only. Cancellation preserves a prior ambiguous resource-creation phase even after the provisioning deadline; absence of a known volume ID is not proof of cleanup. Legacy warm-pool tests use an explicit four-slot fixture and also verify larger configured capacity; that fixture is not a production limit.

## Verified pre.23 canary (2026-10-08)

- Bot execution revision: `1064b5c7acf8ad9c30adde878a36bd635013f608`.
- Core: `1.18.33-bot.13-pre.23`, commit `c2b958b5dfed7976a447b1554814fd41ab38e5a6`.
- Requested and actually observed image: `ghcr.io/aminsh35322088-ctrl/opencode-telegram-worker@sha256:6e95928535983352519cd52dee868d5d01e0f042f3a99e4fa48361b5ae228616`.
- Cloudflare version: `98588993-9a26-4155-9a29-29d94d9c3edd`; deployment: `c6ade95e-f4b6-40ed-a20a-81d5259f3dce`.
- Owned Railway project: `4cd12808-aec4-4b0a-8979-2384d263e284` (`workers-railway-01`).
- Canary Worker: `e4a9b1ac-3ae0-4d1c-95ee-31012d9ddaf3`; service: `e7afc720-5e23-463e-9be5-657fa3989648`; volume: `d92b1499-2432-4604-b372-62a149aa0aa9`.
- Railway deployment: `2d0c4c39-3452-4e7a-835c-eccaef1aa1a3`, SUCCESS; one running replica, zero crashes/warnings before cleanup.
- Allocation-to-signed-ready: 94.312 seconds. Model turn: 7.878 seconds. Python tool exited 0 in the dedicated `/data/topic` workspace.
- Model and tool runs both COMPLETED; corresponding response and Telegram chunk receipts DELIVERED. Retrying the completed request produced no additional model turn. Old generations were rejected before dispatch and after cleanup.
- Final inventory: one registered empty execution project, zero live services/Workers, zero Topic bindings and zero pending infrastructure changes. Worker audit state REPLACED/generation2. Deleted detached canary volume is in Railway retention until `2026-10-10T06:05:22.051Z`; physical purge is not claimed.
- Final tests: 223 Bot Node tests (including 60 Cloudflare tests), 280 Vitest files/2,288 tests, 179 Core Python tests; build/typecheck/lint and existing Core/Bot CI passed. Important Cloudflare/Core tests were rerun after the successful canary and review.

Safe reuse and wake latency were not measured; deletion uses destruction until sanitized rebind is proven. Live sixth-Worker/project rollover was not provisioned for this one-Worker canary; unit tests cover rollover and configurable capacity. Full Telegram UI parity and automatic replacement recovery remain migration work. No Railway Bot/Control service or production local Core execution is running. Legacy Node source is retained until those replacements are tested. Cloudflare deployment is verified; the fork's upstream-guarded npm Publish job is intentionally skipped and no npm package publication is claimed.
