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

The Railway production image ships the bot plus a **baked validation toolchain** at `/opt/test-deps`
(the full dependency tree including dev dependencies, `typescript`, `eslint`, and `vitest@3.2.4`).
It lives in the image layer, so it does not consume the persistent `/data` volume.

The production application uses the runtime capabilities, custom OpenCode tools, and toolchain provided by the image.
Dependency changes belong to source control and the GitHub Actions build/deploy path, never to per-workspace `npm install`.

The persistent `/data` volume is expected to be **500MB**. Runtime exports expose the actual environment budget:

- `OPENCODE_DATA_VOLUME_BUDGET_MB` - configured volume budget (default `500`)
- `OPENCODE_DATA_VOLUME_WARN_MB` - warning threshold (default `150`)
- `OPENCODE_DATA_VOLUME_CRITICAL_MB` - critical threshold (default `100`)
- `OPENCODE_TEST_DEPS` - read-only baked dependency source (default `/opt/test-deps`)

Always trust `df -P /data` or `storage-health` for the live filesystem state rather than assuming the budget equals the current free space.

When the volume is below the warning threshold, keep disposable validation data in `/tmp` and avoid persistent downloads.
When it is below the critical threshold, do not start disk-heavy validation until disposable caches have been cleaned.
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

Define success criteria and verify them. For bugs, reproduce the failure, fix the underlying issue, run a local sanity check with the baked toolchain where useful, and validate through the repository's GitHub Actions CI as the source of truth.

### Git

- **Commits:** Never create commits automatically. Commit only when the user explicitly asks.

## Coding rules

- Code, identifiers, comments, and in-code documentation must be in English.
- User-facing Telegram messages should be localized through i18n.
- Use TypeScript strict mode and existing project style.
- Use `async/await` for asynchronous control flow.
- Log errors with context and never expose stack traces to users.

## Validation policy: GitHub Actions primary, baked-toolchain local checks

GitHub Actions remains the canonical validation authority for this repository.
The CI workflow is defined in `.github/workflows/ci.yml` and owns linting, typechecking, building, and the full test suite.
The test source/configuration lives under `.github/ci-tests/` and is the single source of truth for tests.

The image additionally ships a complete validation toolchain at `/opt/test-deps`
(node_modules including dev dependencies, `typescript`, `eslint`, `vitest@3.2.4`)
so agents can run fast local sanity checks **without installing anything and without consuming the `/data` volume**.

### Disk economy (MANDATORY)

The persistent `/data` volume is a 500MB budget. Every agent action must respect the live free-space thresholds.

- **Discover before writing.** Inspect `df -P /data` or call `storage-health` before disk-heavy work. Never infer available space from an old log.
- **Use the baked tree.** Workspace `node_modules` must be a symbolic link to `/opt/test-deps`; never materialize another dependency tree under `/data`.
- **Never install.** All package-management installs (`npm install`, `npm ci`, `npm add`, `pnpm`, `yarn`, `bun`, `npx`) are forbidden in the runtime and denied by OpenCode permission rules.
- **Keep validation disposable data off-volume.** The full validation tool writes its temporary test tree, build output, and optional coverage only under `/tmp/opencode-full-test-suite`.
- **No persistent build output.** Do not run bare `tsc` in `/data`; the full-test tool redirects emitted build output into `/tmp`.
- **Stop at critical pressure.** Below 100MB free, do not run disk-heavy validation. Run `storage-health` with `cleanup-safe` first; never delete user/session data automatically.
- **Prefer warning headroom.** Below 150MB free, use `/tmp` for disposable data and avoid downloads or generated artifacts on `/data`.
- **Always clean validation artifacts.** The full-test tool removes its `/tmp` sandbox in a `finally` block, including tests, config, build output, and coverage.
- **Never commit materialized CI files.** `tests/`, `vitest.config.ts`, and `tsconfig.test.json` should remain CI-only and are never needed in the persistent workspace.

### Mandatory rules

- **GitHub Actions is the source of truth** for linting, typechecking, building, and the full test suite.
- **Never install** validation packages or run package installers locally.
- **Never create a real `node_modules`** in any workspace; symlink to `/opt/test-deps` instead.
- **Local checks are supplementary.** A green local run does not replace a push that triggers the GitHub Actions workflow.
- Do not bypass the CI policy with equivalent commands through `bash`, `node`, `npx`, `npm exec`, `pnpm`, `yarn`, `bun`, or direct binaries.

### Standard local validation

Use the custom `full-test-suite` tool for the repository's CI-equivalent local validation. It runs changelog policy, source/test lint, source/test typecheck, a real TypeScript build into `/tmp`, and the complete Vitest suite from the baked dependency tree.

Run `storage-health` before or after heavy work when disk state matters. Its `cleanup-safe` action may remove only disposable package/tool caches.

Do not manually recreate the CI test tree under `/data` unless the test itself specifically requires it.

### GitHub Actions workflow

When validation is required:

1. Make the smallest source/configuration change needed.
2. Push or commit the authorized change so `.github/workflows/ci.yml` runs on GitHub.
3. Inspect the GitHub Actions result/logs.
4. Fix failures from the CI evidence and let GitHub Actions validate the next revision.

### Runtime diagnostics

Runtime diagnostics and session recovery are operational tools, not test runners. For a stuck coding session, use `full-diagnostics` and `session-recovery` to inspect and recover the runtime session; never switch to local package installation or ad-hoc dependency bootstrapping.
