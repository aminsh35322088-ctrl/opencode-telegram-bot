# Codex development guide

This repository intentionally separates **Codex development instructions** from the **OpenCode instructions consumed by models running inside the Telegram bot**.

## Instruction separation

| File | Consumer | Purpose |
| --- | --- | --- |
| `AGENTS.override.md` | Codex | Repository-development contract |
| `AGENTS.md` | OpenCode project/runtime agents | Model-facing project instructions used by the bot/OpenCode |
| `.opencode/tools/` | OpenCode runtime | Custom model-facing tools/actions |
| This document | Codex / human maintainers | Architecture and workflow reference |

Do not merge the two instruction layers.

Codex should use the root `AGENTS.override.md`. The existing `AGENTS.md` must remain independently maintainable because it is part of OpenCode's project instruction path and may be injected into bot model sessions.

## Current architecture direction

The project has migrated toward **OpenCode Telegram Core**. The bot should increasingly be a Telegram-specific application layer rather than a second implementation of runtime/session behavior.

The dependency contract is explicit:

- `core-release.lock.json` pins one immutable Core release.
- `package.json` consumes the SDK and native runtime artifacts from that same release.
- The production image consumes the matching Core runtime artifact.
- Runtime/SDK/native identities must not drift.

When reviewing old bot code, ask:

1. Is this logic already owned by Core?
2. Is the bot implementation still reachable?
3. Is it a Telegram/UI/persistence concern that correctly belongs here?
4. Would deleting it change public behavior or only remove a migrated compatibility path?
5. Are all callers routed through the Core-backed path now?

Only remove code after tracing callers and verifying the replacement path.

## High-level execution model

Target conceptual flow:

```text
Telegram update
  -> authentication / topic admission
  -> binding resolution
  -> per-topic request supervision
  -> TopicWorker / Core runtime
  -> OpenCode session + tools
  -> generation-checked outbound routing
  -> Telegram topic
```

The General/ALL chat is a control surface, not an AI execution scope. It must not silently fall back to a model-capable worker.

For detailed routing and historical implementation notes, read `docs/TOPIC_ISOLATION_ARCHITECTURE.md` and current Core-facing code rather than assuming older docs are perfectly current.

## Ownership rules

### Usually belongs in Core

- runtime/session lifecycle primitives
- TopicWorker supervision and execution isolation
- generation fencing/stale-event suppression
- Core-owned OpenCode runtime behavior
- shared sub-agent execution lifecycle
- low-level cross-client runtime capabilities

### Usually belongs in the Bot

- Telegram handlers, menus, keyboards, callbacks and i18n
- Telegram topic binding persistence
- Telegram-specific presentation/stream formatting
- bot-owned Extensions/Actions/Credential Vault UI
- GitHub/Tailscale integration UX
- Railway deployment/bootstrap glue
- application-level storage and migration code when specific to this bot

When uncertain, inspect both repositories before creating a second implementation.

## Topic isolation checklist

Any code touching sessions, streams, tools, permissions, SSH, scheduled tasks, or state must answer all of these:

- What is the owner key?
- Can two Topics execute this concurrently?
- Can a stale event from an old generation mutate/send into a new generation?
- Can a Topic accidentally reuse another Topic's mutable singleton/state?
- What happens after crash/restart?
- What happens on rotate/delete?
- Is General/ALL rejected before model/tool execution?
- Are outbound messages generation/binding checked immediately before send?

For SSH, include remote-workspace isolation in addition to connection/permission isolation.

## Sub-agent contract

Telegram sub-agent Topics are views, not independent controllers.

- Create the view only through the product's inspection flow.
- Keep it read-only.
- Do not expose Stop/Abort controls in the sub-agent view.
- Closing the view only closes Telegram presentation.
- Parent abort may terminate the child execution.
- Parent pause must not turn into child abort/recreation.
- Child state remains subordinate to the parent session lifecycle.

## Railway/resource contract

Production is resource constrained. `docs/PROCESS_BUDGET.md` is authoritative for process admission.

Do not introduce:

- unbudgeted `spawn`, `exec`, `execFile`, or equivalent process creation;
- infinite/tight retries after process admission fails;
- a second dependency tree or ad-hoc installer on the persistent volume;
- uncontrolled background workers;
- shared state whose cleanup depends on container-local `/tmp`.

Remember that a main-branch deployment replaces the running container and can terminate in-flight agent turns.

## Runtime Extensions are not repository dependency edits

Installing/removing/authenticating an Extension, MCP server, Skill, model provider, or integration is a runtime configuration operation unless the user explicitly asks for a source-code change.

Do not encode runtime credentials in:

- source files,
- `AGENTS.override.md`,
- `AGENTS.md`,
- Git history,
- OpenCode config committed to this repository,
- logs or model-visible metadata.

## Verification

GitHub CI is the baseline source of truth. The normal validation sequence is:

```bash
npm ci
node scripts/verify-core-install.mjs
npm run lint
npm run typecheck
npm run build
```

For behavior changes, also run the CI Vitest suite using the same materialized tests/configuration as `.github/workflows/ci.yml`, or rely on the resulting GitHub CI run after a direct push when local materialization is unavailable.

For Core migration changes, verify all of the following before considering the work complete:

- Core artifact pin is immutable and internally consistent.
- SDK/native/runtime identities match.
- old bot route is unreachable or removed.
- Core-backed route is covered by tests.
- topic isolation tests remain green.
- production startup reaches healthy OpenCode + Telegram initialization.
- Railway runtime logs do not show restart loops, memory-pressure regressions, SQLite errors, or OpenCode request failures.

## Context hygiene for Codex

Keep the root override concise. Do not copy every product decision into it.

Load only the relevant reference documents for the task. This avoids wasting model context and prevents stale operational notes from competing with current code.

If a decision becomes a durable project invariant, document it in the appropriate architecture/product document and keep only a short pointer in `AGENTS.override.md`.
