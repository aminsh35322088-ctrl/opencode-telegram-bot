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

The Railway production image is a runtime environment, not a CI runner.
It intentionally does not ship the repository's CI-only test suite or a validation toolchain.
Do not install testing, linting, typechecking, or build-validation tools into the production runtime.

The production application may use the existing runtime/coding utilities and custom OpenCode tools. Dependency-management actions are for application/workspace operations only; they are not a validation path.

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

Define success criteria and verify them. For bugs, reproduce the failure, fix the underlying issue, and validate through the repository's GitHub Actions CI instead of running local validation in the production runtime.

### Git

- **Commits:** Never create commits automatically. Commit only when the user explicitly asks.

## Coding rules

- Code, identifiers, comments, and in-code documentation must be in English.
- User-facing Telegram messages should be localized through i18n.
- Use TypeScript strict mode and existing project style.
- Use `async/await` for asynchronous control flow.
- Log errors with context and never expose stack traces to users.

## Validation policy: GitHub Actions only

GitHub Actions is the sole validation authority for this repository.
The CI workflow is defined in `.github/workflows/ci.yml` and owns linting, typechecking, building, and the test suite.
The test source/configuration lives under `.github/ci-tests/` and is materialized only inside the GitHub Actions runner.

### Mandatory rules

- **NEVER run tests locally** in the Railway container, OpenCode session, project workspace, or a review worktree.
- **NEVER run local lint, typecheck, build, or equivalent validation** as a substitute for GitHub Actions.
- **NEVER invoke** `vitest`, `jest`, `mocha`, `pytest`, Playwright test runners, or any other test runner locally.
- **NEVER install** test runners, linters, typecheckers, or validation-only packages to make local validation possible.
- **NEVER recreate** the CI-only `tests/`, `e2e/`, `vitest.config.ts`, or `tsconfig.test.json` files in the production workspace.
- Do not use the dependency-management tool to obtain or install a validation toolchain.
- Do not bypass the CI policy with equivalent commands through `bash`, `node`, `npx`, `npm exec`, `pnpm`, `yarn`, `bun`, or direct binaries.

### GitHub Actions workflow

When validation is required:

1. Make the smallest source/configuration change needed.
2. Push or commit the authorized change so `.github/workflows/ci.yml` runs on GitHub.
3. Inspect the GitHub Actions result/logs.
4. Fix failures from the CI evidence and let GitHub Actions validate the next revision.

Do not attempt to reproduce CI validation locally in the production bot. A CI failure is a GitHub Actions signal to fix the source, not a reason to install a local validation stack.

### Runtime diagnostics

Runtime diagnostics and session recovery are operational tools, not test runners. For a stuck coding session, use `full-diagnostics` and `session-recovery` to inspect and recover the runtime session; never switch to local CI/test execution.
