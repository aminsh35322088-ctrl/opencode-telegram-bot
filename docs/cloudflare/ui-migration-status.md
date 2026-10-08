# Cloudflare Telegram UI migration

The persistent Telegram application now runs in the existing Cloudflare ControlPlane SQLite Durable Object. Core remains execution-only on Railway. General never creates a runtime for ordinary messages. New Chat remains lazy, dedicated and bounded by backend policy.

## Implemented routes

- Existing public Telegram command catalog, General inline/reply navigation, History, New Chat and Topic keyboard restoration.
- Topic Settings, model/agent/variant catalog choices, image/audio model selectors, exact model inspection, scoped output preferences, queue admission, session/messages/context inspection, rename, automatic run keyboards, abort/stop/pause/resume and confirmed deletion.
- Session todos, changed-file summaries, direct-child sub-agent messages and bounded relative workspace file browsing/reading/downloads through signed Core RPC.
- Canonical revisioned provider, skill, MCP, plugin, extension, generated Action, custom command and persistent-memory configuration; Topic defaults and experimental settings.
- Provider API credential entry encrypted before durable update persistence; signed, narrowly scoped provider proxy leases. No provisioning credentials are available to Core/model processes.
- Questions, multiple/custom answers and permissions bound to actor/chat/thread/generation/run. Exact question receipts authorize global mutation prepare/commit.
- Durable UTC scheduled tasks feeding the existing ordered Topic queue, with explicit save/toggle/delete receipts.
- Two-stage Factory Reset retains monotonic canonical revision, gates new allocation, cancels pending jobs and cleans bound Topics before clearing credentials/configuration.
- Durable resolved action receipts prevent retries becoming prompts or repeating mutation. Known Telegram rate limits retry; ambiguous delivery is reconciled without blind resend.
- Immutable in-place Worker image upgrade preserves service/volume/session ownership; dispatch is gated until actual Railway source/deployment and signed runtime identity agree.

## Remaining parity work

These are explicit incomplete features, not substitutes for execution:

- GitHub and Tailscale connection screens describe their required scoped Core integration. Legacy container-global token injection/tailscaled/SSH cannot run in Cloudflare and is not reintroduced.
- Photo/document/audio attachments now cross as bounded inline file parts (256 KiB each), without Telegram credential URLs. Dedicated image generation and voice transcription workflows still need Core capability wiring and compatible provider/model configuration.
- Signed-event text/tool/thinking previews now use bounded Telegram edits and survive control restarts. Compact and thought visibility preferences apply to previews. Completed text uses the existing native Telegram block renderer and Persian/RTL support; raw output, run footer and changed-file document preferences are active. Native draft mode and richer tool-specific cards still need parity work.
- Natural-language task scheduling is currently replaced by validated UTC JSON schedules.
- Context compaction must become a governed explicit Core model operation before exposing an active compaction control.
- Cleanup currently destroys a dedicated service and volume; safe sleeping Worker reuse is not yet proven.

Do not claim complete legacy UI parity or full migration based on this document. Record actual deployment, regression and runtime verification separately.

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
