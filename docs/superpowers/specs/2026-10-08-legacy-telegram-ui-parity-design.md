# Legacy Telegram UI Parity on Cloudflare — Design

Date: 2026-10-08
Repository: `aminsh35322088-ctrl/opencode-telegram-bot`

## Goal

Restore the Telegram user interface to match the final pre-Cloudflare bot UI as closely as practical while preserving the new Cloudflare control-plane and Railway/Core execution architecture.

The legacy UI under `src/bot/**` is the canonical source of truth for presentation and interaction behavior. Cloudflare remains responsible for durable state, admission, secrets, provisioning, routing, retries, receipts and lifecycle coordination. Railway/OpenCode Core remains responsible for execution.

Success means a user opening the bot should recognize the old product: the pinned Main panel, Model Center, Main Settings, Topic Settings, navigation semantics, reply keyboards and inline-menu behavior should look and behave like the pre-Cloudflare bot rather than the simplified UI currently implemented in `src/cloudflare/bot-ui.ts`.

## Non-goals

- Do not revert to the legacy stateful bot runtime.
- Do not move execution back into the bot or Cloudflare Worker.
- Do not reintroduce container-global credentials, shared mutable session state, unscoped SSH/Tailscale access, or duplicated Core execution logic.
- Do not redesign the Telegram UX while doing this migration.
- Do not require feature-complete GitHub/Tailscale capability rewiring in the first UI-only slice; their existing UI surfaces should be restored, while capability wiring can follow separately where backend adapters are still incomplete.

## Architecture

```text
Telegram
   ↓
Cloudflare webhook / admission
   ↓
Legacy UI adapter layer
   ↓
src/bot/**        ← canonical Telegram presentation and interaction behavior
   ↓
Cloudflare state/capability adapters
   ↓
Control Plane Durable Object / SQLite
   ↓
Railway Topic Worker
   ↓
OpenCode Telegram Core
```

Ownership boundaries:

- `src/bot/**`: Telegram presentation, menu hierarchy, labels, navigation, keyboard composition and interaction behavior.
- `src/cloudflare/**`: webhook admission, durable state, callback receipts, credentials, fleet lifecycle, retries, signed RPC, transport and execution coordination.
- Railway/Core: topic-scoped execution and governed tools/processes.

The current Cloudflare UI implementation must stop independently redefining Model Center, Settings, Session UI and other user-facing flows. It should become an adapter/transport layer around canonical legacy UI logic.

## Canonical legacy UI surfaces to restore

### Main / General

Restore the old Main panel behavior:

- Rich status text headed by `⚡ OpenCode Telegram`.
- Ready state, Bot version, OpenCode/Core version, active model and agent.
- Existing explanatory copy.
- Inline navigation with `💬 New Chat`, `🕘 History`, and `⚙️ Main Settings`.
- Persistent canonical Main message in the forum root/All view.
- Pin the canonical Main message.
- `/start` replaces the canonical Main panel safely instead of creating a simplified duplicate flow.
- Preserve rollback behavior if pinning or persistence fails.

### Inline navigation semantics

Reuse the legacy navigation model:

- Prefer editing the active canonical inline panel instead of sending a new message for every submenu.
- Preserve `← Back`, `🏠 Home`, and `✖ Close` semantics.
- Track/re-hydrate the active inline menu per chat/topic.
- Ignore stale callbacks safely.
- Topic and General navigation remain scoped correctly.

### Model Center

Reuse the actual legacy Model Center flow and presentation:

- Current model block.
- Favorites.
- Recent models.
- Search.
- Browse providers.
- Provider pages and pagination.
- Model selection.
- Favorite toggle.
- Capability icons.
- Existing provider price/color presentation where data is available.
- Existing Back/Home behavior.

Cloudflare-backed model catalogs and topic-scoped model persistence should be exposed through adapters rather than rebuilding Model Center UI in `src/cloudflare/bot-ui.ts`.

### Main Settings

Restore the pre-Cloudflare Main Settings hierarchy and menu style, including the existing UI surfaces for:

- Default model/configuration.
- Providers.
- GitHub.
- Tailscale.
- Extensions.
- Actions.
- MCP/Skills/custom commands where they existed in the legacy Settings tree.
- Additional existing advanced/settings sections.

Backend mutations must remain revisioned and durable in Cloudflare.

### Topic UI

Restore the legacy Topic UI behavior:

- Reply keyboard shape and labels.
- Running / paused controls.
- Abort/Stop/Pause/Resume.
- Compact output control.
- Model button using the active topic model label.
- Delete Chat and Topic Settings.
- Topic Settings hierarchy.
- Agent and variant selection.
- Session/context/files navigation.
- Queue-related UI where supported.

No Topic UI action may bypass topic generation fencing or session ownership checks.

### Session / Context / Files

Reuse the legacy presentation patterns for:

- Session status/history.
- Message history.
- Context health/compaction controls when the current Core runtime supports them.
- Todos.
- Changed-file summaries/diffs.
- File browser and download actions.
- Direct-child sub-agent inspection where supported.

Actual data comes through signed Cloudflare→Core RPC adapters.

## Adapter strategy

The preferred implementation is an adapter bridge, not a copy of old UI code.

Introduce narrowly scoped interfaces that legacy UI modules can consume without depending on the old local runtime stores. Typical adapter responsibilities:

- Read/write current model and agent for General/Topic scope.
- Read/write topic UI preferences.
- Read providers/model catalog/favorites/recent data.
- Resolve session/context/files information via signed Core RPC.
- Persist canonical Main panel message ID and active-menu state in Durable Object SQLite.
- Commit configuration mutations through revision-checked Cloudflare state.
- Route provider credentials through the existing protected credential flow.
- Preserve callback actor/chat/thread/generation validation.

Where a legacy UI module currently reads a process-local store directly, replace that dependency with an interface rather than duplicating the UI in Cloudflare code.

## Cloudflare `bot-ui.ts` direction

`src/cloudflare/bot-ui.ts` currently contains substantial duplicate presentation logic. During this migration:

1. Keep Cloudflare-specific webhook parsing, actor validation, callback receipt validation, generation checks and RPC dispatch.
2. Route presentation to shared/legacy UI builders and menu handlers.
3. Remove duplicate hard-coded Settings/Model Center/menu trees only after equivalent legacy paths are live and tested.
4. Avoid a big-bang deletion; move one user-visible surface at a time and retain fallback only during the migration.

The end-state is that Cloudflare owns transport/state boundaries, while `src/bot/**` owns Telegram UX.

## Compatibility and safety

- General/All must never allocate a model runtime for ordinary UI navigation.
- New Chat remains lazy and provisions a dedicated Worker only when needed.
- Topic generation fencing remains mandatory for all writable actions.
- A stale callback must never mutate a newer topic generation.
- Provider/Railway/Telegram secrets remain Cloudflare secret bindings and must not be exposed to model processes.
- GitHub/Tailscale UI can be restored before all backend capability adapters are complete, but disabled/unavailable actions must clearly report their state instead of silently falling back to unsafe legacy behavior.
- No legacy container-global Tailscale daemon or token injection is reintroduced.

## Migration order

1. Main `/start` panel, pinning, replacement semantics and General navigation.
2. Same-message inline navigation (`Back/Home/Close`) and active menu tracking.
3. Model Center.
4. Main Settings hierarchy.
5. Topic reply keyboard and Topic Settings.
6. Session / Context / Files flows.
7. Remaining legacy presentation surfaces.
8. Remove duplicate Cloudflare presentation code once parity is proven.

This order gives immediate visible parity without changing the execution plane.

## Testing strategy

### Repository tests

Add/adjust tests to verify:

- `/start` creates/replaces exactly one canonical root Main panel and records its ID.
- The Main panel has the legacy status text and button hierarchy.
- Main panel pin failure rolls back safely.
- Submenus edit the canonical active panel rather than spamming new messages where legacy behavior expects edits.
- `Back`, `Home`, `Close` and stale callback handling match legacy behavior.
- Model Center exposes favorites, recent, search, providers and selection.
- Topic keyboard matches legacy labels/layout for idle/running/paused states.
- Topic-scoped mutations reject stale generations.
- General UI navigation never invokes execution RPC.

### Live validation

After source tests pass:

1. Deploy Cloudflare control plane.
2. Verify `/start` in the real forum group.
3. Confirm one pinned canonical Main panel exists in All/root.
4. Exercise Main Settings and Model Center interactively.
5. Create a Topic and verify legacy Topic keyboard/Topic Settings.
6. Run a real model request through Railway/Core and ensure UI remains correct during running/idle transitions.
7. Inspect Cloudflare and Railway logs for errors and regressions.
8. Iterate until the live UI and logs are clean.

## Acceptance criteria

The UI-only migration slice is complete when:

- A user familiar with the pre-Cloudflare bot recognizes the Main and Topic UI immediately.
- `/start` restores the legacy rich pinned Main status panel.
- Model Center is the real legacy Model Center, not a simplified replacement.
- Main Settings and Topic Settings follow the legacy hierarchy and navigation behavior.
- Menu navigation edits/reuses panels as before instead of generating avoidable message spam.
- Cloudflare remains the control/state plane and Railway/Core remains the execution plane.
- No unsafe legacy credential/runtime behavior is restored.
- CI passes and the live Telegram validation is successful with clean control-plane/runtime logs.
