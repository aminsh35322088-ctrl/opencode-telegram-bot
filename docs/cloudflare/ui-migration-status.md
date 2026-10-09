# Cloudflare Telegram UI migration

The persistent Telegram application now runs in the existing Cloudflare ControlPlane SQLite Durable Object. Core remains execution-only on Railway. General never creates a runtime for ordinary messages. New Chat remains lazy, dedicated and bounded by backend policy.

## Implemented routes

- **Legacy Telegram UI parity restoration:** the pre-Cloudflare `src/bot/**` presentation is canonical again for the pinned Main panel, same-message Back/Home/Close navigation, Main/Topic Settings, the full Model Center (Favorites/Recent/Search/Providers/pagination), reply keyboards, and Session/Context/Files views. Cloudflare owns durable state/callback fencing/transport while these legacy builders own labels, hierarchy and layout.

- Existing public Telegram command catalog, General inline/reply navigation, History, New Chat and Topic keyboard restoration.
- Topic Settings, model/agent/variant catalog choices, image/audio model selectors, exact model inspection, scoped output preferences, queue admission, session/messages/context inspection, rename, automatic run keyboards, abort/stop/pause/resume and confirmed deletion.
- Session todos, changed-file summaries, direct-child sub-agent messages and bounded relative workspace file browsing/reading/downloads through signed Core RPC.
- Canonical revisioned provider, skill, MCP, plugin, extension, generated Action, custom command and persistent-memory configuration; Topic defaults and experimental settings.
- Guided global Skill, custom command and remote MCP entry with durable scoped drafts, bounded previews, explicit confirmation and canonical revision checks. Advanced JSON retains local MCP/detailed configuration support. Cancel invalidates pending confirmation; successful commit receipts prevent rate-limit retries from advancing the revision again.
- Provider API credential entry encrypted before durable update persistence; signed, narrowly scoped provider proxy leases. No provisioning credentials are available to Core/model processes.
- Questions, multiple/custom answers and permissions bound to actor/chat/thread/generation/run. Exact question receipts authorize global mutation prepare/commit.
- Guided scheduled-task creation (schedule → task text → confirmation), durable scoped drafts, explicit save/toggle/delete receipts and UTC schedules feeding the existing ordered Topic queue. Common `every N minutes/hours/days`, `in N minutes/hours/days` and exact UTC timestamps need no JSON; Advanced JSON remains available.
- Two-stage Factory Reset retains monotonic canonical revision, gates new allocation, cancels pending jobs and cleans bound Topics before clearing credentials/configuration.
- Durable resolved action receipts prevent retries becoming prompts or repeating mutation. Known Telegram rate limits retry; ambiguous delivery is reconciled without blind resend.
- Immutable in-place Worker image upgrade preserves service/volume/session ownership; dispatch is gated until actual Railway source/deployment and signed runtime identity agree.

## Remaining parity work

These are explicit incomplete features, not substitutes for execution:

- GitHub and Tailscale connection screens describe their required scoped Core integration. Legacy container-global token injection/tailscaled/SSH cannot run in Cloudflare and is not reintroduced.
- Photo/document/audio attachments now cross as bounded inline file parts (256 KiB each), without Telegram credential URLs. Dedicated image generation and voice transcription workflows still need Core capability wiring and compatible provider/model configuration.
- Signed-event text/tool/thinking previews now use bounded Telegram edits and survive control restarts. Compact and thought visibility preferences apply to previews. Completed text uses the existing native Telegram block renderer and Persian/RTL support; raw output, run footer and changed-file document preferences are active. Native private-chat drafts, durable final receipts and safe tool cards are now implemented. Final streamed messages use the existing native renderer and RTL metadata, including editing the original preview.
- Broader natural-language/cron schedule interpretation still needs governed Core integration. The guided flow supports only the explicitly listed interval/one-time formats; it does not guess ambiguous schedules.
- Context compaction is implemented in Core pre.25 through the owned asynchronous run protocol, gated by configured and observed Worker versions. Production validation is recorded separately.
- Cleanup currently destroys a dedicated service and volume; safe sleeping Worker reuse is not yet proven.

Do not claim complete legacy UI parity or full migration based on this document. Record actual deployment, regression and runtime verification separately.

## Legacy UI parity validation, 2026-10-08

- Source migration commits: `b1b891bc` adapter boundary, `b9a49628` pinned Main/navigation, `17101340` legacy Model Center, `9151c2fc` legacy Settings/Topic controls, `45908c0c` Session/Context/Files, `f1da6353` duplicate-presentation cleanup.
- Current repository HEAD during final verification: `0eef2e012293aab7ce1a60220248ec7784adb03f`; commits after `f1da6353` are CI/dependency maintenance and do not change the Worker UI source.
- Exact repository gate on the final dependency set: 379/379 distributed boundary tests; lint, typecheck and build pass; 2,288/2,288 Vitest assertions across 280 files pass. `npm audit` reports 0 moderate, 0 high and 0 critical findings (4 low upstream findings remain).
- GitHub `CI` and manually dispatched `Full Test Suite` both completed successfully on the final HEAD.
- Cloudflare Version 40 (`ee7b3712-f04c-495e-ae22-fa4db52fe4ca`) is deployed at 100%. Its script etag exactly matches the already-tested parity Version 39, all five existing bindings were inherited under strict resolution, and `/health` returns HTTP 200 with `execution:false`.
- Railway project `workers-railway-01` reports two retained Topic Workers, both healthy and sleeping with no pending work. Runtime logs contain successful headless starts and accepted governed canary runs; no new deployment failure was observed during this UI rollout.
- Automated source/runtime validation proves the canonical UI path is deployed. Final pixel/interaction acceptance still requires the real Telegram client to invoke `/start` and visually compare the resulting panel/navigation with the historical UI; do not infer that human visual acceptance from unit tests alone.

## Live validation, 2026-10-08

- Bot UI/source commits: `3010f6f1`, `a41fca16`, `634faf4b`; subsequent readiness/override fix is recorded in Git history.
- Core commit `56106d84f1c5b8c050241141d938fe1f185dc94f`, release `1.18.33-bot.13-pre.24`.
- Running image verified against Railway source: `ghcr.io/aminsh35322088-ctrl/opencode-telegram-worker@sha256:6faae202026012b61db18073044fed2e441a277875d72ecc23bdfd484b7511c6`.
- In-place Worker deployments: `a5ab7a18-60f6-45f4-83d5-f694fa0d6f2f` and `1155a8e8-046e-4ed1-9465-95321774eedc`. Service, volume, Topic generation and session identities retained. No new Railway resources created by these upgrades.
- Cloudflare health confirms execution=false and credential presence without values. General/Topic start, Settings, Session, Models, Agent and Files menus acknowledged by Telegram.
- Real model/tool canary `ui_pre24_canary_20261008`: signed Worker request accepted, governed bash/Python output marker verified from owned session history, matching assistant text verified, response DELIVERED; signed execution status null afterward.
- Real feedback canary `ui_feedback_canary_20261008`: COMPLETED, response/outbox DELIVERED; preview message 29313 retained and finalized, bash tool completed, 113 visible characters. No files modified by either canary.
- Latest verification: lint/typecheck/build passed; 308 repository tests passed; wider existing regression suite 2,288 tests / 280 files passed. Core release verification: 205 Python, 299 Bun, 385 compiled headless checks passed (two skips); existing Core CI/release jobs green.
- Second review fixed sleeping readiness admission, nonduplicated global defaults, streaming mode type, expired/caption credentials, active-form media routing, uncertain preview delivery, internal confirmation bypass and rate-limit mutation replay.
- Railway API and Telegram credentials remain protected Cloudflare secret bindings. Telegram allowed identity binding was also converted to protected secret without returning its value.

This validates the implemented UI slice. It does not prove complete legacy integration parity, safe free-Worker reuse, recovery replacement, six-Topic rollover or full cutover.

### Fresh provisioning and cleanup canary

- Job `dbd85fb2-2fef-42eb-ba13-95504075e941` lazily provisioned Worker `ffcbb858-ed24-47eb-8db5-28f845950aff` and activated Telegram Topic `762995`. Allocation to observed signed readiness took approximately 95 seconds.
- Railway deployment `616c5e9a-f306-413f-8a37-663fc2d4c57c` passed startup health after expected bootstrap retries. Attached volume and actual signed Core version/commit/image agreed with the pinned `.24` runtime.
- Real run `ui_fresh_worker_canary_20261008` completed governed bash/Python execution and Telegram delivery. Its preview message `29320` was finalized; signed Worker status was inactive afterward.
- Canary deletion fenced generation 1, removed the Telegram Topic and Railway service, and marked the registry Worker REPLACED at generation 2. Volume `900ceff5-6b94-4c1b-aaac-1416f29a050b` is detached and pending Railway's delayed deletion, rather than available for another Topic. Both existing user execution services remain intact; Railway reports two services, zero issues and zero recent failures.
- Followup UI review corrected ignored canonical Topic defaults, initial queue-toggle behavior, unsupported draft-mode selection and raw internal preference labels. Failure responses no longer request workspace diffs. Regression assertions on exact stop/status behavior remain unchanged.

## Navigation bug fixes, 2026-10-09

The canonical panel is persisted per actor/chat/thread/generation. Start, menus, forms, notices, history transitions, readiness and run-control updates edit it instead of sending duplicate control panels. Legitimate responses/questions are separate messages. Validated existing legacy menu messages can be adopted during migration. Safe navigation is reusable and recovers on the same panel; destructive/configuration actions remain one-shot, time-limited and generation-fenced. Only a definitive deleted-message response allows creating a replacement panel. Unsolicited ALL input is consumed and deleted without model execution or a reply loop; active bot-requested forms remain accepted.

Accepted streamed turns are not re-submitted for every event. Earliest-alarm scheduling preserves immediate callback wakes; throttled previews schedule their next display deadline. Core-owned session titles propagate to the corresponding Topic while manual names remain authoritative. Worker image/Core pins move together to pre.25, with no additional user secret bindings.
