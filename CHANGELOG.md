# Changelog

All notable Telegram-bot changes are documented here. OpenCode has its own independent release/version lifecycle.

## [Unreleased]

### Added
- Topic isolation architecture is now documented in `docs/TOPIC_ISOLATION_ARCHITECTURE.md`: the ALS scope contract, the per-topic vs per-session keying rules for all mutable state, and the liveness guarantees behind concurrent multi-Topic AI chat.
- `TopicScopedValue` primitive: one mutable value per Telegram Topic scope, resolved from the runtime context, used to give every Topic its own independent setup wizards.
- `general.topic_only_prompt` message in all supported languages.

### Fixed
- Retired AI Topics now purge their service-side runtime state (assistant/thinking/tool/compact streams, tool-message batches, elapsed timers, run state, chat bindings) when the model is switched or the Topic is deleted, closing per-session leaks and stale-flush delivery to the chat root.
- Dropped artifacts without a Telegram destination now log at warn level instead of debug.
- The General ("All") Topic of a forum group is now a lobby: free-text AI prompts, voice/audio prompts, coding-AI photos and prompt documents typed there are rejected with a clear message unless the bot is explicitly waiting for input (wizard step, question, rename, task setup, model search, Image AI). AI chats keep running in their own Topics; private chats and AI Topic threads are unchanged.
- The New Chat confirmation no longer hijacks the pinned Main anchor: the glass button panel stays under the ⚡ OpenCode Telegram welcome message instead of being reposted under "✅ New session created".
- Bot-initiated aborts (stall watchdog recovery, scheduled-task session cleanup, Image AI coding-model takeover, deterministic provider-retry policy) now expect the resulting `Aborted` session error, so a red "🔴 OpenCode returned an error: Aborted" no longer appears in the middle of a conversation.
- Provider, Integrations (GitHub/Railway) and MCP-add wizards are now per-Topic: two Topics can no longer hijack or cancel each other's in-progress form, and text typed in one Topic is never consumed by another Topic's wizard.
- Generated artifact files are now delivered into the Topic thread that produced them instead of always landing at the chat root.
- Context accounting (used tokens, context limit, cost, changed files) is tracked per session, so a concurrently streaming Topic can no longer show another Topic's context usage on the keyboard or pinned state.
- AI Topic bottom keyboards now show each Topic's own persisted model after restarts/re-opens instead of the ambient default: keyboard state initialization resolves the model and agent directly from the Topic runtime store rather than relying on the async Topic context being active.
- Concurrent live chats across AI Topics no longer freeze when another Topic attaches: switching aggregator focus no longer wipes other sessions' in-flight aggregation state, every session-rooted event gate now honors the per-event Topic runtime context, and switching the model in one Topic retires only that Topic's event subscription instead of tearing down every Topic's stream.
- Reasoning/thinking parts that arrive after the finalized assistant answer are no longer delivered, and pending thinking flushes are serialized through the completion queue, so the final answer is always the last message in a Topic.
- Reply Keyboard controls pressed while replying to a bot message are now classified from the authentic button label instead of the enriched `Replying to @Chat Bot.` text, so Topic and control buttons are consumed as controls and no longer fall through into Coding AI prompt handling.
- AI Topic slash commands (`/abort`, `/pause`, `/resume`, `/model`, `/compact`, `/topic_settings`, `/delete_topic`, and friends) sent while in Telegram reply mode are no longer corrupted by reply-context enrichment, so `bot.command()` routing matches them instead of leaking them into Coding AI prompts.
- AI Topic run-management commands (`/pause`, `/resume`, `/delete_topic`, `/stop`) now reach their handlers while a run is busy or an interaction is pending, matching the behavior of the equivalent Reply Keyboard buttons.
- Reply Keyboard controls pressed in Telegram reply mode are now **dispatched** (not just recognized): the router drives action matching from the authentic pre-enrichment label, so recognized controls like Delete Chat, Topic Settings, Model, Compact, Pause, Resume and Abort actually execute instead of being consumed silently.

### Changed
- Concurrent AI topics are the tested baseline for `summaryAggregator` gating and per-topic keyboards (see the linked architecture doc).

### Removed
- Dead legacy `setActiveTelegramTopic`/`getActiveTelegramTopic` no-op API and all call sites.
- Unreachable Gemini wizard branch and its unused constants in the providers command.
- Deprecated duplicated top-level `session/model/agent/compactOutputMode` fields from Topic runtime states; `settings` is the single source of truth (legacy files are still migrated on load).

## [0.26.2] - 2026-09-04

### Fixed
- Hardened Topic keyboard routing so reserved controls cannot fall through into Coding AI prompt handling.
- Fixed paused Topic prompts so sending a new instruction resumes the existing session with the actual prompt instead of a generic Resume signal.
- Prevented Image AI generation/editing from racing with Coding AI input in the same session.
- Fixed Image AI assets being associated with the wrong active session when session context changes during generation/editing.

### Changed
- Image AI operations now mark the owning session busy for the duration of generation/editing and return it to idle reliably.
- Topic-aware session routing now keeps streaming, tool/progress output, callbacks, pause state, keyboard state, and Image AI state scoped to the active session.
- Removed duplicate `socks-proxy-agent` and `unified` dependency entries from `package.json`.

### Release / Update notification
- Bot version is now `v0.26.2`.
- `/start` and `/update` show the previous → current bot version and the v0.26.2 release notes once per installed version.

## [0.26.0] - 2026-09-04

### Added
- Added private Telegram Topic-backed coding sessions with isolated OpenCode sessions and per-topic workspaces.
- Added per-topic Pause, Resume, Abort, Model, Image AI, and Delete Chat controls.
- Preserved the existing Image AI Generate and Edit flows inside each coding Topic, with generated/edited assets stored in that Topic workspace.
- Added reply-to-message context for Topic conversations, including referenced text/captions and downloaded image/document attachments.
- Added implicit Resume from a user prompt while a Topic is paused; the prompt is delivered to the existing session so the model can incorporate the instruction into the interrupted task.

### Changed
- The main private chat is now used for controls and session creation, while each coding session lives in its own Telegram Topic.
- Topic deletion now removes only the bound OpenCode session, isolated workspace, Telegram Topic, and binding.
- Topic-aware routing now carries streaming, tool/progress output, callbacks, pause state, keyboard state, and Image AI mode within the active session boundary.
- While Image AI is generating or editing, Coding AI input is blocked until the image operation completes; generated/edited assets are saved against the session captured for that operation.
- Reserved Topic reply-keyboard controls are prevented from falling through to Coding AI prompt handling.
- Model Center and live custom-provider catalog improvements from the 0.25.x line remain part of the current bot experience.
- Updated `/start` to point users toward New Chat and existing Topics instead of the removed History flow.

### Fixed
- Prevented duplicate Topic creation for the same OpenCode session with per-session single-flight handling.
- Scoped paused sessions and Image AI modes by OpenCode session instead of keeping a single global value.
- Callback Topic resolution now uses the callback message's own chat/thread identity rather than assuming the current global chat context.
- Topic workspace cleanup is path-guarded so deleting a Topic cannot remove the main project directory.
- Fixed paused-prompt handling so the user's actual instruction resumes the same session instead of being reduced to a generic Resume signal.

### Release / Update notification
- Bot version is now `v0.26.0`.
- `/start` and `/update` show the previous → current bot version and the v0.26.0 release notes once per installed version.

## [0.25.3] - 2026-09-04

### Changed
- Simplified model labels throughout Model Center to show the model name only; provider/company names are no longer repeated on model buttons.
- Added human-friendly model-name formatting so IDs such as `gpt-5.1-codex` render as readable model names while preserving the original provider/model IDs.
- Model search now matches both model IDs and their advertised display names.

### Fixed
- Custom Provider model display names from the live `/models` catalog are now preserved and shown instead of falling back to raw IDs.
- `/start` and `/update` now use a built-in release-notes fallback, so Changelog delivery does not depend on `docs/release-notes` being present in the runtime image.
- Update notifications mark a version as delivered only after the notification and Changelog messages are successfully sent, preventing a failed Changelog send from being silently suppressed.
- Updated the model-format regression tests to match the canonical model-only button format.
- Corrected the release version used by the package metadata to `v0.25.3`.

### Release / Update notification
- Bot version is now `v0.25.3`.
- `/start` and `/update` show the previous → current bot version and the current release Changelog once per installed version.

## [0.25.2] - 2026-09-04

### Added
- Reworked Model Center into the single canonical model UI with Favorites, Recent Models, provider browsing, model search, and per-model favorite controls.
- Added persistent favorite and recent model state with bounded recent history.
- Added automatic custom-provider model catalog refresh every 5 minutes, plus an immediate refresh when Model Center opens.

### Changed
- All Model Center callbacks now use the dedicated `mc:*` namespace.
- Persistent model-selector keyboard navigation now opens the same Model Center used by Settings.
- Favorites and Recent results show the provider beneath each model so identical model IDs remain distinguishable.
- Provider-specific model pages no longer repeat the provider ID on every model button.
- Custom-provider catalogs are authoritative for Model Center and replace stale OpenCode copies.

### Fixed
- Removed the obsolete legacy Model Center menu implementation.
- Removed legacy model callback routing and its model-index/provider-index selection flow.
- Large provider catalogs remain paginated and live provider refreshes no longer truncate `/models` responses at 100 entries.
- Short runtime callback tokens keep Telegram callback data bounded while a bounded in-memory token cache prevents unbounded session growth.
- Persistent Model Select button detection remains restricted to the canonical single-line model/provider format.
- The persistent keyboard no longer opens the obsolete AI Rules screen when the user wants to change the active model.

### Release / Update notification
- Bot version is now `v0.25.2`.
- `/start` detects the bot-version migration and sends the previous → current version notice plus `docs/release-notes/v0.25.2.md` once per installed version.
- `/start` continues to show both the Telegram Bot and bundled OpenCode versions.

## [0.25.1] - 2026-09-03

### Fixed
- Normalized the persistent model selector label into a single clean line.
- Added a bounded display length with balanced truncation for very long model and provider IDs so the full-width keyboard button stays visually consistent.

## [0.25.0] - 2026-09-03

### Added
- Independent Telegram Bot versioning, separate from OpenCode.
- Bot update migration notices on `/start` and `/update`.
- `/all version info` for the running bot, OpenCode, runtime, dependencies, and integrated tools.
- Release notes surfaced by the bot after a detected bot update.

### Changed
- Settings now exposes Model selection instead of the removed AI Rules entry.
- Appearance settings include persisted Message format (Markdown/Raw).
- `/start` shows both the bot version and OpenCode version.
- Redesigned model selection into a cleaner Model Center with explicit current-model, favorites, recent, search, and provider browsing flows.
- Removed redundant per-model and per-provider `verified` labels; provider/API validation remains part of the connection and catalog validation flow.
- Moved the persistent model selector to a dedicated full-width reply-keyboard row and moved Image AI into the compact control row.
- Preserved model-selection callback namespaces and added safe HTML escaping for dynamic model/provider values.

## [0.24.1]

- Previous development baseline before the formal independent bot release track.
