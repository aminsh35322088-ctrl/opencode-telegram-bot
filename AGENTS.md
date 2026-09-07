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

The Railway production image is both the bot runtime and the project's controlled self-validation environment.
The image ships a read-only validation toolchain in image layers so test execution never installs packages into `/data`.
Dependency installation belongs to the image build; agents must not mutate the workspace dependency tree.

The repository's CI-only test suite remains source-controlled under `.github/ci-tests/` and is materialized into a workspace only when validation is requested.

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

Define success criteria and verify them. For bugs, reproduce the failure, fix the underlying issue, and validate through both the bot's self-validation environment and GitHub Actions when available.

### Git

- **Commits:** Never create commits automatically. Commit only when the user explicitly asks.

## Validation policy: bot self-validation + GitHub Actions

The bot has a preinstalled validation toolchain in the Docker image. It is safe to use because validation dependencies live in image layers, while `/data` receives only source/test files and symlinks.
GitHub Actions remains the final CI authority and must still be inspected for repository validation.

### Mandatory rules

- **NEVER run `npm install`, `npm ci`, `npm i`, `npm add`, or equivalent dependency installation inside `/data` or a project workspace.**
- **NEVER install test runners, linters, typecheckers, or validation-only packages into a workspace.**
- Before any potentially disk-heavy validation operation, run `df -h /data`. If free space is below **100 MB**, abort the operation and clean up first.
- Always use the image-provided dependency tree through the workspace `node_modules` symlink. Never replace it with a real installation.
- The shared dependency tree is read-only by policy. Do not modify, prune, update, or uninstall packages from it.
- CI-only tests are materialized only for the duration of validation and must be removed afterwards.
- After heavy work, clean temporary files and obsolete validation output from `/tmp` and the workspace.
- Do not keep generated coverage, caches, downloads, archives, or other disposable data in `/data` unless the user explicitly asks to retain them.
- Periodically remove stale `topic-workspaces` older than the project's configured retention window; do not delete active sessions.

### Allowed self-validation commands

Use the preinstalled toolchain directly. Preferred commands are:

- `vitest run`
- `tsc --noEmit`
- `tsc -p tsconfig.test.json --noEmit`
- `eslint ...`
- `prettier --check ...`
- `node_modules/.bin/*`

Do not use `npm test`, `npm run test`, `npm exec`, `npx`, or package-installing commands as substitutes.

### Self-validation workflow

1. Check disk space with `df -h /data` and abort below 100 MB free.
2. Ensure the workspace uses the image-provided `node_modules` symlink.
3. Materialize `.github/ci-tests/tests`, `.github/ci-tests/tsconfig.test.json`, and `.github/ci-tests/vitest.config.ts` only when the CI-equivalent suite is needed.
4. Run the smallest relevant validation first, then the full suite when the change is broad or user-facing.
5. Remove materialized tests, coverage, temporary files, and disposable logs after validation.
6. Inspect GitHub Actions results for the same revision and fix any CI-specific failures.

### GitHub Actions workflow

When GitHub validation is required:

1. Make the smallest source/configuration change needed.
2. Push or commit the authorized change so `.github/workflows/ci.yml` runs on GitHub.
3. Inspect the GitHub Actions result/logs.
4. Fix failures from the CI evidence and validate the next revision.

Do not treat a green local self-test as a substitute for GitHub Actions.

### Runtime diagnostics

Runtime diagnostics and session recovery are operational tools, not substitutes for validation. For a stuck coding session, use `full-diagnostics` and `session-recovery` to inspect and recover the runtime session.

## Coding rules

- Code, identifiers, comments, and in-code documentation must be in English.
- User-facing Telegram messages should be localized through i18n.
- Use TypeScript strict mode and existing project style.
- Use `async/await` for asynchronous control flow.
- Log errors with context and never expose stack traces to users.
