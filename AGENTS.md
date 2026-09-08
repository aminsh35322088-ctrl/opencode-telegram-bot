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

Railway is production only. Do not turn the production container into a test runner.

The full validation suite runs directly in **GitHub Actions**. CI-only tests live under `.github/ci-tests/` and are materialized only on the GitHub-hosted runner. Test runners and validation-only packages must never be installed into Railway or `/data`.

Dependency changes belong in source control and the GitHub Actions build/validation path.

## AI agent behavior

### GitHub-first validation

After reading this file, use GitHub as the source of truth for repository work.

For code changes:
1. Inspect the relevant source and existing GitHub history.
2. Make the smallest correct change.
3. Push/commit the authorized change to GitHub.
4. Let `.github/workflows/ci.yml` run on GitHub Actions.
5. Inspect the Actions result and logs.
6. Fix failures and repeat until the revision passes.

Do not install test dependencies in Railway to imitate CI. Do not create a second runtime dependency tree for validation.

### Surgical changes

Touch only what is necessary. Do not refactor unrelated code or delete unrelated dead code.

### Goal-driven execution

For bugs, identify the root cause, implement the fix, validate the affected path, then validate the repository through GitHub Actions.

### Communication

- Reply in the same language the user uses.
- User-facing Telegram text must use the existing i18n system.
- Do not expose internal stack traces to users.

### Git

When the user explicitly asks for a fix/change, direct GitHub changes are authorized. Keep commits focused and descriptive.

## Validation policy: GitHub Actions only

GitHub Actions is the canonical and exclusive environment for linting, typechecking, building, and the full test suite.

The canonical workflow is `.github/workflows/ci.yml`.

CI:
- installs project dependencies on the GitHub runner;
- installs CI-only test tooling on the GitHub runner;
- materializes `.github/ci-tests/` temporarily;
- runs lint, typecheck, build, and tests;
- removes temporary test files and coverage before finishing.

### Mandatory rules

- Never run `npm install`, `npm ci`, `npm add`, `npx`, or equivalent commands in Railway merely to obtain test tooling.
- Never ship Vitest or other CI-only validation dependencies in the Railway production image.
- Never create `/opt/test-deps`, `node_modules.full`, or another baked validation dependency tree.
- Never materialize CI tests into persistent `/data` workspaces.
- Runtime diagnostics are operational diagnostics, not test execution.

## Runtime diagnostics

For a stuck coding session, use the existing runtime diagnostics and recovery tools. Do not turn those tools into a local test runner.

## Coding rules

- Code, identifiers, comments, and in-code documentation must be in English.
- Use TypeScript strict mode and existing project style.
- Use `async/await` for asynchronous control flow.
- Log errors with context and never expose stack traces to users.
