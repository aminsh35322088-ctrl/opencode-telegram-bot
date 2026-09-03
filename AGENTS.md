# AGENTS.md

Instructions for AI agents working on this project.

## About the project

**opencode-telegram-bot** is a Telegram bot that acts as a mobile client for OpenCode.
It lets a user run and monitor coding tasks on a local machine through Telegram.

Functional requirements, features, and development status are in [PRODUCT.md](./PRODUCT.md).

## Technology stack

- **Language:** TypeScript 5.x
- **Runtime:** Node.js 22.14+
- **Package manager:** npm
- **Configuration:** environment variables (`.env`)
- **Logging:** custom logger with levels (`debug`, `info`, `warn`, `error`)

### Core dependencies

- `grammy` - Telegram Bot API framework (https://grammy.dev/)
- `@grammyjs/menu` - inline keyboards and menus
- `@opencode-ai/sdk` - official OpenCode Server SDK
- `dotenv` - environment variable loading

### Test dependencies

- Vitest
- Mocks/stubs via `vi.mock()`

## Coding environment

The production container is intentionally equipped as a general-purpose coding workspace. In addition to Node.js/npm and Git, it provides shell utilities, search/navigation tools, GitHub CLI, Python, SQLite, and native build tooling.

The production image also preinstalls common validation tools globally (`tsc`, `vitest`, `eslint`, `tsx`) so repeated interactive checks should not download packages.

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

Define success criteria and verify them. For bugs, reproduce the failure, fix the underlying issue, and run focused validation before broader validation.

### Git

- **Commits:** Never create commits automatically. Commit only when the user explicitly asks.

## Coding rules

- Code, identifiers, comments, and in-code documentation must be in English.
- User-facing Telegram messages should be localized through i18n.
- Use TypeScript strict mode and existing project style.
- Use `async/await` for asynchronous control flow.
- Log errors with context and never expose stack traces to users.

## Logging

Use `src/utils/logger.ts` with level-based logs. Keep detailed diagnostics under `debug`, operational lifecycle events under `info`, recoverable issues under `warn`, and critical failures under `error`. Avoid raw console logging in feature code.

## Testing

### What to test

- Unit tests for business logic, formatters, managers, runtime helpers
- Integration-style tests around OpenCode SDK interaction using mocks
- Focus on critical paths; avoid over-testing trivial code

### Agent validation commands

- Prefer `.opencode/tools/test-runner.ts` for project test, build, lint, or typecheck validation instead of raw shell commands.
- Never use `npx` for tools already installed in the container (`tsc`, `vitest`, `eslint`, `tsx`); it can trigger package resolution/downloads and make diagnostics appear hung.
- Never run `rm -rf node_modules` as a routine validation step.
- Never run `npm ci` as a routine interactive test step. `npm ci` is for clean CI/container provisioning.
- When dependencies are actually missing, inspect `package.json`, the lockfile, and the current dependency tree first; use the dependency manager tool instead of repeatedly starting from zero.
- Keep validation commands bounded and do not hide exit codes behind pipelines.
- If validation times out, investigate the process/network/tool lifecycle instead of blindly reinstalling dependencies.

### Recovery path for stuck agent work

1. Stop repeating the same command or reinstalling dependencies.
2. Inspect the current session status and recent events.
3. Use the `session-recovery` tool to inspect and, when appropriate, abort the stuck session.
4. Retry the smallest useful operation.
5. If the same route fails again, switch to another validation method.
6. Preserve diagnostic evidence so recovery does not erase the original failure mode.
