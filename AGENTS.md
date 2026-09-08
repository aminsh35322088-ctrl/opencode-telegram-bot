# AGENTS.md

Instructions for AI agents working on this project.

## About the project

**opencode-telegram-bot** is a Telegram bot client for OpenCode.
It lets users run and monitor coding tasks through Telegram.

Functional requirements, features, and development status are in [PRODUCT.md](./PRODUCT.md).

## Technology stack

- **Language:** TypeScript 5.x
- **Runtime:** Node.js 22.14+
- **Package manager:** npm
- **Configuration:** environment variables (`.env`)
- **Logging:** custom logger with levels (`debug`, `info`, `warn`, `error`)

### Core dependencies

- `grammy` - Telegram Bot API framework
- `@grammyjs/menu` - inline keyboards and menus
- `@opencode-ai/sdk` - official OpenCode Server SDK
- `dotenv` - environment variable loading

## Runtime environment

The Railway production image contains only production dependencies from `npm ci` followed by `npm prune --omit=dev`.
It does **not** ship Vitest, TypeScript test dependencies, a second `node_modules` tree, or any other CI-only validation packages.

The production application uses the runtime capabilities, custom OpenCode tools, and system toolchain provided by the image.
Dependency changes belong to source control and the GitHub Actions build/deploy path, never to per-workspace `npm install`.

The persistent `/data` volume is expected to be **500MB**. Runtime exports expose the actual environment budget:

- `OPENCODE_DATA_VOLUME_BUDGET_MB` - configured volume budget (default `500`)
- `OPENCODE_DATA_VOLUME_WARN_MB` - warning threshold (default `150`)
- `OPENCODE_DATA_VOLUME_CRITICAL_MB` - critical threshold (default `100`)

Always trust `df -P /data` or `storage-health` for the live filesystem state rather than assuming the budget equals the current free space.

When the volume is below the warning threshold, keep disposable runtime data in `/tmp` and avoid persistent downloads.
When it is below the critical threshold, do not start disk-heavy work until disposable caches have been cleaned.
Only the `storage-health` tool's `cleanup-safe` action may automatically delete disposable tool/package caches; it must never delete user workspaces, sessions, databases, source files, or generated user artifacts.

When a user asks for an archive, create a real archive with shell tooling and verify it before delivery.

### Sending generated files to Telegram

When the user asks to receive a generated file, archive, website, image, document, build artifact, or other output file, use the custom `send_file` tool after the file has been created and verified.

For multi-file projects, create a real archive first, verify it, then call `send_file` with the archive path.

## Architecture

### Main components

1. **Bot Layer** - grammY setup, middleware, commands, callback handlers
2. **OpenCode Client Layer** - SDK wrapper and SSE event subscription
3. **State Managers** - session/project/settings/question/permission/model/agent/variant/keyboard/pinned
4. **Summary Pipeline** - event aggregation and Telegram-friendly formatting
5. **Process Manager** - local OpenCode server process start, stop, and status
6. **Runtime/CLI Layer** - runtime mode, config bootstrap, CLI commands
7. **I18n Layer** - localized bot and CLI strings to multiple languages

### Data flow

```text
Telegram User
  -> Telegram Bot (grammY)
  -> Managers + OpenCodeClient
  -> OpenCode Server

OpenCode Server
  -> SSE Events
  -> Event Listener
  -> Summary Aggregator / Tool Managers
  -> Telegram Bot
  -> Telegram User
```

### State management

- Persistent state is stored in `settings.json`.
- Active runtime state is kept in dedicated in-memory managers.
- Session/project/model/agent context is synchronized through OpenCode API calls.
- The app is currently single-user by design.

## AI agent behavior rules

### Communication

- **Response language:** Reply in the same language the user uses in their questions.
- **Clarifications:** If plan confirmation is needed, use the `question` tool. Do not make major decisions (architecture changes, mass deletion, risky changes) without explicit confirmation.

### Think Before Coding

Don't assume. Before implementing, state assumptions, surface tradeoffs, and prefer the simplest solution that meets the request.

### Surgical Changes

Touch only what is necessary. Do not refactor unrelated code or delete unrelated dead code.

### Goal-Driven Execution

Define success criteria and verify them. For bugs, reproduce the failure, fix the underlying issue, run a local sanity check when useful, and validate through the repository's GitHub Actions CI as the source of truth.

### Git

- **Commits:** Never create commits automatically. Commit only when the user explicitly asks.

## Validation policy: GitHub Actions only for the full suite

GitHub Actions is the canonical and exclusive environment for the repository's full lint/typecheck/build/test validation.
The CI workflow is defined in `.github/workflows/ci.yml` and owns linting, typechecking, building, and the full test suite.
The manually triggerable `.github/workflows/full-test-suite.yml` runs the same validation on demand without sharing the Railway production process.
The test source/configuration lives under `.github/ci-tests/` and is the single source of truth for tests.

CI installs the test runner and materializes the CI-only test tree temporarily on the GitHub-hosted runner. Those packages and files must not be copied into the Railway image or persistent workspaces.

### Disk economy (MANDATORY)

The persistent `/data` volume is a 500MB budget. Runtime agent actions must respect the live free-space thresholds.

- **Discover before writing.** Inspect `df -P /data` or call `storage-health` before disk-heavy work. Never infer available space from an old log.
- **No CI dependency tree in production.** Never create `/opt/test-deps`, `node_modules.full`, or another validation dependency tree in the Railway image.
- **Never install test packages in runtime.** Do not run `npm install`, `npm ci`, `npm add`, `npx`, `npm exec`, `pnpm`, `yarn`, or `bun` merely to obtain validation packages inside the Railway runtime.
- **Keep validation off Railway.** The `full-test-suite` OpenCode tool delegates the complete suite to GitHub Actions instead of executing tests locally.
- **No persistent test output.** CI-only `tests/`, `vitest.config.ts`, and `tsconfig.test.json` are materialized and removed inside the GitHub Actions runner.
- **Stop at critical pressure.** Below 100MB free, do not run disk-heavy runtime diagnostics. Run `storage-health` with `cleanup-safe` first; never delete user/session data automatically.
- **Prefer warning headroom.** Below 150MB free, use `/tmp` for disposable runtime work and avoid downloads or generated artifacts on `/data`.

### Mandatory rules

- **GitHub Actions is the source of truth** for linting, typechecking, building, and the full test suite.
- **Do not ship test dependencies in production.** The Docker runtime must contain production dependencies only.
- **Do not bypass CI** with local test-package installation inside Railway.
- **Local runtime diagnostics are not tests.** `full-diagnostics` and `session-recovery` are operational tools for stuck sessions; they do not replace CI validation.

### GitHub Actions workflow

When validation is required:

1. Make the smallest source/configuration change needed.
2. Push or commit the authorized change so `.github/workflows/ci.yml` runs, or trigger `.github/workflows/full-test-suite.yml` for an explicit full-suite run.
3. Inspect the GitHub Actions result/logs.
4. Fix failures from the CI evidence and validate the next revision.

### Runtime diagnostics

Runtime diagnostics and session recovery are operational tools, not test runners. For a stuck coding session, use `full-diagnostics` and `session-recovery` to inspect and recover the runtime session; never switch to local package installation or ad-hoc dependency bootstrapping.
