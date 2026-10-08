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
