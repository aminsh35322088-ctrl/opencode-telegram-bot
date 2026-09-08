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
It lives in the image layer, so it costs zero bytes on the 500MB `/data` volume.

The production application uses the runtime capabilities, custom OpenCode tools, and toolchain provided by the image.
Dependency changes belong to source control and the GitHub Actions build/deploy path, never to per-workspace `npm install`.

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

The `/data` volume is 500MB. Every agent action must respect this budget:

- **Symbolic-link dependencies only.** Use `ln -s /opt/test-deps node_modules` in the workspace. NEVER create a real `node_modules` in `/data`.
- **Never install.** All package-management installs (`npm install`, `npm ci`, `npm add`, `pnpm`, `yarn`, `bun`, `npx`) are forbidden here and denied by opencode permission rules. The baked `/opt/test-deps` is the only dependency source.
- **Check before writing.** Before any command that writes to disk, run `df -h /data`. If free space is below 100MB, STOP and ask before proceeding.
- **Never write build output.** Run `tsc --noEmit` for typechecking. NEVER run bare `tsc` (or `npm run build`) which emits `dist/` into `/data`.
- **Materialize tests temporarily, then clean up.** Copy the CI test suite into place, run it, then remove it in the same operation:
  - `cp -a .github/ci-tests/tests tests`
  - `cp .github/ci-tests/vitest.config.ts vitest.config.ts`
  - `cp .github/ci-tests/tsconfig.test.json tsconfig.test.json`
  - run checks, then `rm -rf tests vitest.config.ts tsconfig.test.json coverage`
- **Never commit materialized CI files.** `tests/`, `vitest.config.ts`, `tsconfig.test.json`, `coverage/` must never be committed.
- **Clean up caches and temp files** after heavy operations (`/tmp`, tool caches) and never leave downloaded files in `/data`.
- **Prune stale sessions.** Old session artifacts under `topic-workspaces/` may be removed to reclaim space, but only with explicit user confirmation.

### Mandatory rules

- **GitHub Actions is the source of truth** for linting, typechecking, building, and the full test suite.
- **Never install** validation packages or run package installers locally.
- **Never create a real `node_modules`** in any workspace; symlink to `/opt/test-deps` instead.
- **Local checks are supplementary.** A green local run does not replace a push that triggers the GitHub Actions workflow.
- Do not bypass the CI policy with equivalent commands through `bash`, `node`, `npx`, `npm exec`, `pnpm`, `yarn`, `bun`, or direct binaries.

### Local check recipe (allowed)

When a fast local sanity check is useful before pushing:

1. Ensure `node_modules` is a symlink to `/opt/test-deps` (create with `ln -s /opt/test-deps node_modules` if missing).
2. Typecheck: `./node_modules/.bin/tsc --noEmit` (and `./node_modules/.bin/tsc -p tsconfig.test.json --noEmit` after materializing tests).
3. Lint: `./node_modules/.bin/eslint src --max-warnings=0` (and `eslint tests --max-warnings=0` after materializing).
4. Test: materialize the CI test suite (see above), run `./node_modules/.bin/vitest run`, then remove the materialized files.

### GitHub Actions workflow

When validation is required:

1. Make the smallest source/configuration change needed.
2. Push or commit the authorized change so `.github/workflows/ci.yml` runs on GitHub.
3. Inspect the GitHub Actions result/logs.
4. Fix failures from the CI evidence and let GitHub Actions validate the next revision.

### Runtime diagnostics

Runtime diagnostics and session recovery are operational tools, not test runners. For a stuck coding session, use `full-diagnostics` and `session-recovery` to inspect and recover the runtime session; never switch to local CI/test execution.
