# Native Run Presentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Telegram run presentation match OpenCode-style UX: persistent expandable reasoning, compact expandable tool/activity history, continuous typing, and restart-safe run recovery without changing final-answer rendering.

**Architecture:** Keep reasoning, activity, and final answer as separate presentation surfaces owned by the same run. Native Telegram draft remains the live surface; completed reasoning and activity become persistent expandable blockquotes. The control-plane scheduler owns typing heartbeats and bounded restart recovery.

**Tech Stack:** TypeScript, Cloudflare Workers/Durable Objects SQLite, Telegram Bot API, Node test runner.

**Spec:** Conversation-approved behavior on 2026-10-13.

## Global Constraints

- Final answer rendering/finalization behavior must remain unchanged.
- Completed reasoning is always `expandable_blockquote`; no length/line threshold.
- Tool/activity UI is aggregated per run and must not expose credentials or unbounded raw output.
- `typing` must continue while a run is active, including when native draft presentation is enabled.
- Restart recovery must be bounded/indexed and must not reintroduce Durable Object row-read amplification.
- Work lands only through a PR; do not merge or deploy.

## Review Focus

- Multiple reasoning phases in one run must persist without merging into the final answer.
- Repeated updates for the same tool call must update one activity item, not duplicate it.
- Sensitive tool arguments and oversized stdout must never be rendered verbatim.
- A Worker/DO restart with queued/finalizing work must schedule exactly bounded recovery work.
- Native presentation and typing must coexist without Telegram rate-limit amplification.

---

### Task 1: Reasoning persistence contract

**Files:** `src/cloudflare/run-presentation.ts`, `src/bot/messages/thinking-rendering.ts`, relevant tests.

- [x] Add/adjust failing tests proving completed reasoning always renders as an independent expandable blockquote.
- [x] Remove short/long final-reasoning branching while preserving native live reasoning.
- [x] Verify native-generation/presentation tests.

### Task 2: Aggregated expandable activity presentation

**Files:** `src/cloudflare/run-presentation.ts` or a focused activity presenter module, event capture tests.

- [x] Add failing tests for Skill/Grep/Glob/Read/Edit/Write/Shell/Web/Task aggregation, dedupe/update, redaction, bounded summaries, and separation from final answer.
- [x] Implement a per-run activity buffer and compact summary rendering as a persistent expandable blockquote.
- [x] Verify activity presentation tests.

### Task 3: Continuous typing with native presentation

**Files:** `src/cloudflare/control-object.ts`, control-object tests.

- [x] Add failing test proving active native presentation still emits/schedules `sendChatAction(typing)`.
- [x] Remove the native-presentation exclusion while preserving existing 4s/rate-limit heartbeat behavior.
- [x] Verify typing tests.

### Task 4: Remote Topic SDK compatibility and non-responsive Topic recovery

**Files:** `src/control-plane/topic-sdk-adapter.ts`, `src/infrastructure/node-transport.ts`, adapter/transport tests.

- [x] Reproduce production attach failure for `permission.list` and provider catalog reads.
- [x] Route those operations through the already-supported authenticated Worker/Core RPC surface; do not fake empty permission state.
- [x] Preserve generation/session fencing and verify adapter/transport tests.

### Task 5: Integration and PR gate

- [x] Run lint, build, diff-check, targeted suites, and the full test suite.
- [x] Review diff for final-answer regressions, secrets, and unbounded presentation growth.
- [x] Commit, push feature branch, open PR against `main` with test evidence and scope notes.

## Compact Context

- expose manual Compact Context from Topic Context Health
- route SDK `session.summarize` to Worker/Core `session.compact` with the exact governed run identity
- keep Core run ownership until the real `session.compacted` event arrives; fail on session error/idle/abort
- refresh existing context state from the native compaction event; do not synthesize summaries in Bot
