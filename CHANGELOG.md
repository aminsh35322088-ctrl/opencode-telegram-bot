# Changelog

All notable Telegram-bot changes are documented here. OpenCode has its own independent release/version lifecycle.

## [Unreleased]

### Added
- Reworked Model Center with dedicated Favorites, Recent Models, provider browsing, model search, and per-model favorite controls.
- Added persistent favorite and recent model storage with bounded recent history.
- Added automatic custom-provider model catalog refresh across all configured API keys every 5 minutes, plus an immediate refresh when Model Center opens.

### Fixed
- Custom-provider catalogs are now authoritative over stale OpenCode provider model lists, preventing counts such as 110 from persisting after a provider is reduced to 8 models.
- Provider model lists are paginated to keep large catalogs usable and within Telegram keyboard/message limits.
- Persistent Model Select button detection now matches only the canonical single-line model/provider format, preventing it from being misclassified as a normal prompt.
- Model selection actions use short runtime callback tokens instead of embedding arbitrary provider/model IDs in Telegram callback data.

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
- Preserved existing model-selection callback namespaces and added safe HTML escaping for dynamic model/provider values.

## [0.24.1]

- Previous development baseline before the formal independent bot release track.
