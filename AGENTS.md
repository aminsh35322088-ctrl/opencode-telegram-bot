# AGENTS.md

Instructions for AI agents working on this project.

## First step — read this file

Always read `AGENTS.md` before changing code. It is the project's operating contract.

## Skills — use them in every session

The list of available skills appears in `<available_skills>` in the system prompt. This rule applies to every topic, every model, and every workspace.

- Before answering any non-trivial request, scan the skill descriptions. If there is even a small chance a skill applies, load it with the `skill` tool and follow it — without waiting for the user to ask.
- Typical mappings: new feature or behavior change → `brainstorming`; bug, failing test, unexpected behavior → `systematic-debugging`; implementing any feature or fix → `test-driven-development`; about to claim work complete → `verification-before-completion`; dense or structurally complex material that needs a map → `focus-friendly`.
- Skills are the default workflow, not optional polish. Missing an applicable skill counts as an error.
- When creating a skill (manually, via GitHub import, or through `writing-skills`), always give it a clear `description:` in the SKILL.md frontmatter so the bot's `/skills` catalog shows a meaningful, skill-specific description.

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

### Where to work

The persistent repository checkout lives at `/data/opencode/opencode-telegram-bot` and tracks `main`.

When a task needs a working copy on a branch, create a git worktree **inside the agent's own session workspace** and work there:

```bash
git -C /data/opencode/opencode-telegram-bot worktree add "$PWD/repo" -b <branch> origin/main
ln -sfn /app/node_modules "$PWD/repo/node_modules"
```

Never create worktrees, clones, or repo copies under `/tmp`: container restarts wipe `/tmp`, which orphans in-progress work, leaves stale `.git/worktrees` metadata behind, and forces work to be redone. Only disposable build/test output may go to `/tmp`.

Commit and push early — GitHub is the durable store, the worktree is not. After the branch is merged or abandoned, remove it:

```bash
git -C /data/opencode/opencode-telegram-bot worktree remove <path> && git worktree prune
```

### Surgical changes

Touch only what is necessary. Do not refactor unrelated code or delete unrelated dead code.

Before removing an exported app-service function, grep `.opencode/tools/` as well: custom runtime tools load compiled services dynamically (for example the railway tool's store contract against `/app/dist/app/services/railway-integration-service.js`), which static import scans cannot see.

### Goal-driven execution

For bugs, identify the root cause, implement the fix, verify the affected path, then verify the repository build and deployment behavior.

### Communication

- Reply in the same language the user uses.
- User-facing Telegram text must use the existing i18n system.
- Do not expose internal stack traces to users.
- Prefer static bot actions/menus (the `.opencode/tools` catalog and Telegram UI flows) over raw `bash` when the bot already exposes the same capability.

### MCP credentials and OAuth

- MCP OAuth/client secrets are derived from the bot token key material and stored encrypted by the bot. They must never appear in OpenCode config files, model prompts, logs, or user-facing error text.
- Rotating `TELEGRAM_BOT_TOKEN` invalidates stored MCP secret encryption; re-enter credentials after rotation.
- OAuth callback URLs and authorization codes are deleted from Telegram immediately after use and are never sent to the model.

### Custom provider tool calling

- OpenCode custom-provider models stay fail-closed (`tool_call: false`) until a real tool-call probe succeeds for that exact model.
- Startup writes the fail-closed config first; probe refresh runs in the background and rewrites the config when verification completes.
- When the selected model falls back because it is unavailable or not agent-capable, notify the user through i18n — do not rely on `logger.warn` alone.

### Git

When the user explicitly asks for a fix/change, direct GitHub changes are authorized. Keep commits focused and descriptive.

## Runtime diagnostics

For a stuck coding session, use the existing runtime diagnostics and recovery tools. Keep operational diagnostics separate from application execution paths.

## Coding rules

- Code, identifiers, comments, and in-code documentation must be in English.
- Use TypeScript strict mode and existing project style.
- Use `async/await` for asynchronous control flow.
- Log errors with context and never expose stack traces to users.
