# Codex repository instructions

This file is for **Codex repository-development sessions only**.

## Instruction boundary

- `AGENTS.md` is reserved for OpenCode project/runtime agents used by the Telegram bot. Do not edit, replace, copy, or merge it to configure Codex.
- OpenCode runtime/project models must continue to receive `AGENTS.md`; Codex-specific guidance belongs here in `AGENTS.override.md` and in `docs/CODEX.md`.
- Never inject this file into Telegram model prompts, TopicWorkers, sub-agents, OpenCode session instructions, runtime Extensions, Skills, or MCP configuration.
- Do not add Codex-only instructions beneath `.opencode/`; that directory is part of the bot/OpenCode runtime surface.
- If a task explicitly concerns the bot's model-facing instructions, treat `AGENTS.md` as product/runtime configuration, not as this Codex contract.

Read `docs/CODEX.md` before substantial work. Load the linked architecture documents only when relevant; keep context lean.

## Repository role

`opencode-telegram-bot` is the Telegram application/control-plane around OpenCode Telegram Core.

The migration direction is **Core-first**:

- Prefer Core-owned implementations for session/runtime behavior already provided by `opencode-telegram-core`.
- Do not re-introduce duplicate or legacy bot-side implementations for behavior owned by Core.
- If a defect belongs in Core, fix Core and move the bot's immutable Core release pin rather than adding a permanent compatibility fork in the bot.
- Bot-specific Telegram UI, persistence, integrations, routing, and glue remain in this repository when they are genuinely application concerns.

The installed Core release is pinned by `core-release.lock.json` and the matching package URLs in `package.json`. Treat runtime, SDK, and native Core artifacts as one compatibility unit.

## Non-negotiable architecture invariants

- General/ALL is not an AI execution topic: no TopicWorker, model turn, tool execution, or implicit agent session may be created there.
- AI execution is topic-scoped and fail-closed. Never share mutable session, worker, abort, stream, permission, SSH, tool-journal, queue, or workspace state across Topics.
- Routing identity must remain unambiguous across `chatId + threadId + sessionId + normalizedDirectory + generation`; stale/late events must not escape their generation.
- Sub-agent Telegram views are read-only inspection surfaces. Closing a view must not stop execution; parent abort may abort children; parent pause must pause rather than recreate/abort them.
- SSH is Tailnet-only, permission/state is Topic-owned, and Topics sharing a host must still use separate remote workspaces.
- Every bot-started OS child process must pass through the process-budget registry. Do not add raw process spawning outside the approved governor.
- Runtime Extensions/Skills/MCP/provider configuration is app state. Do not mutate repository dependencies or Git history merely to install/configure a runtime Extension.
- Keep hard-coded Integrations limited to the product's current supported set; do not resurrect removed provider/integration experiments without an explicit task.

## Where to read next

Use these as sources of truth instead of expanding this file:

- `docs/CODEX.md` — Codex workflow, repository map, Core migration rules, and verification.
- `PRODUCT.md` — product behavior and user-facing scope.
- `docs/TOPIC_ISOLATION_ARCHITECTURE.md` — topic/session isolation.
- `docs/PROCESS_BUDGET.md` — Railway resource/process constraints.
- `docs/AGENT_TOOLBELT.md` — model-facing OpenCode tool surface. This describes the **bot's agents**, not Codex.
- `docs/RAILWAY.md` — production/runtime deployment behavior.

## Change workflow

1. Inspect current `main`, the relevant code, and the pinned Core release before changing behavior.
2. Decide ownership first: Bot concern vs Core concern. Avoid compatibility code that duplicates Core.
3. Make the smallest coherent change and preserve topic isolation/resource boundaries.
4. Run the repository verification that matches CI:
   - `npm ci`
   - `node scripts/verify-core-install.mjs`
   - `npm run lint`
   - `npm run typecheck`
   - `npm run build`
   - the Vitest CI suite when code/behavior changed
5. For Core changes, verify the Core artifact/release first, then update this repo's immutable pin and verify Bot/Core identity.
6. Check GitHub CI after pushing. For production-affecting changes, inspect Railway build/runtime health too.
7. Do not claim completion while a known failing check, deployment regression, or runtime error remains.

## Coding discipline

- TypeScript strict mode; existing project style; English code/comments/docs.
- Keep Telegram user-facing strings in the existing i18n system.
- Do not expose secrets, credentials, stack traces, auth codes, or encrypted runtime material.
- Prefer deletion of obsolete migration shims after their Core replacement is verified; do not keep two active implementations "just in case".
- Preserve existing public behavior unless the task intentionally changes it.
