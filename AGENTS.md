# AGENTS.md

Instructions for AI agents working on this project.

## First step — read this file

Always read `AGENTS.md` before changing code. It is the project's operating contract.

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

Railway is production only. Keep production runtime dependencies minimal and deterministic.

Dependency changes belong in source control and are resolved during the normal GitHub/container build process. The running bot must not install or mutate its application dependency graph on demand.

## AI agent behavior

### GitHub-first workflow

After reading this file, use GitHub as the source of truth for repository work.

For code changes:
1. Inspect the relevant source and existing GitHub history.
2. Make the smallest correct change.
3. Push/commit the authorized change to GitHub.
4. Inspect the resulting GitHub build/deployment status.
5. Inspect Railway build/runtime logs after deployment.
6. Fix failures and repeat until the revision is healthy.

Do not create a second application dependency tree on the Railway volume. Do not add disposable build tooling to the production image.

### Surgical changes

Touch only what is necessary. Do not refactor unrelated code or delete unrelated dead code.

### Goal-driven execution

For bugs, identify the root cause, implement the fix, verify the affected path, then verify the repository build and deployment behavior.

### Communication

- Reply in the same language the user uses.
- User-facing Telegram text must use the existing i18n system.
- Do not expose internal stack traces to users.

### Git

When the user explicitly asks for a fix/change, direct GitHub changes are authorized. Keep commits focused and descriptive.

## Runtime diagnostics

For a stuck coding session, use the existing runtime diagnostics and recovery tools. Keep operational diagnostics separate from application execution paths.

## Coding rules

- Code, identifiers, comments, and in-code documentation must be in English.
- Use TypeScript strict mode and existing project style.
- Use `async/await` for asynchronous control flow.
- Log errors with context and never expose stack traces to users.
