# Changelog

All notable Telegram-bot changes are documented here. OpenCode has its own independent release/version lifecycle.

## [Unreleased]

### Changed
- Moved the repository's automated test suite out of the production tree and into `.github/ci-tests`; GitHub Actions now materializes and removes the suite only inside the CI workspace.
- Removed the OpenCode `test-runner` tool and production-side test executables/install steps so Railway runtime no longer carries Vitest, pytest, TypeScript, or ESLint just for validation.

### Fixed
- `Always Allow` permission decisions are now persisted by Telegram chat and permission type, so later requests in the same chat are auto-approved instead of repeatedly showing confirmation prompts.
- Persisted `Always Allow` rules survive bot restarts and are only created after OpenCode successfully accepts the original approval.

## [0.25.3] - 2026-09-04

### Changed
- Simplified model labels throughout Model Center to show the model name only; provider/company names are no longer repeated on model buttons.
- Added human-friendly model-name formatting so IDs such as `gpt-5.1-codex` render as readable model names while preserving the original provider/model IDs internally.
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
