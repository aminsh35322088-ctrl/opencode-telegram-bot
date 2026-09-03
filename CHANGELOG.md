# Changelog

All notable Telegram-bot changes are documented here. OpenCode has its own independent release/version lifecycle.

## [Unreleased]

### Changed
- Redesigned model selection into a cleaner Model Center with explicit current-model, favorites, recent, search, and provider browsing flows.
- Removed redundant per-model and per-provider `verified` labels; provider/API validation remains part of the connection and catalog validation flow.
- Moved the persistent model selector to a dedicated full-width reply-keyboard row and moved Image AI into the compact control row.
- Preserved existing model-selection callback namespaces and added safe HTML escaping for dynamic model/provider values.
- Preserved full model IDs and provider IDs in the persistent model button instead of truncating them.

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

## [0.24.1]

- Previous development baseline before the formal independent bot release track.
