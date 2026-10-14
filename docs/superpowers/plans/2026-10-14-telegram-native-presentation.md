# Bot Telegram-Native Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or subagent-driven-development task-by-task. Checkboxes are evidence, not intent.

**Goal:** Complete Bot PR #191 with only Bot-owned Telegram lifecycle/UI integration while Core PR #31 owns semantic Telegram parsing/rendering.

**Architecture:** `@opencode-telegram/native-runtime` is the authoritative Telegram document parser/renderer. Bot aggregates trusted run state, constructs Core semantic documents when needed, and uses its existing fallback-aware Telegram delivery. No parallel Details/math/date/reference/table/button grammar is added to Bot.

**Spec:** `docs/superpowers/specs/2026-10-14-telegram-native-presentation-design.md`

**Core dependency:** `aminsh35322088-ctrl/opencode-telegram-core#31`

## Global constraints

- Final answer generation/finalization remains separate and unchanged.
- Completed visible reasoning is always an independent expandable quote.
- Activity is one run-owned logical stream; tool kinds do not create separate spam messages.
- Activity uses Core-native `details`, collapsed by default.
- Secret redaction precedes rich and fallback rendering.
- Model-authored interactive buttons remain disabled.
- Exact-topic typing, Stop attribution, Remote Topic fences and Context Compaction remain intact.
- Button styles change presentation only; callback data stays byte-for-byte unchanged.
- No arbitrary text-color syntax.
- No merge/deploy until fresh full CI, docs and independent review are complete.

## Task 1 — Core/Bot ownership split

**Core PR:** #31

- [x] Audit Core pre.34/current main for Details, math, date-time, anchors/references, expandable quotes, rich buttons, tables, RTL and fallbacks.
- [x] Document that these semantics remain Core-owned.
- [x] Open Core PR #31 with independent spec and implementation plan.
- [x] Add Core RED test proving GFM tables were not compact by default.
- [x] Implement Core GFM `isCompact: true` policy while preserving explicit HTML table semantics.
- [x] Add RED test for a public Core capability descriptor.
- [x] Export `TELEGRAM_RICH_PRESENTATION_CAPABILITIES` from native runtime.
- [ ] Record final all-green Core CI run, update #31 docs and mark ready for review.
- [x] Remove the Bot compact-table post-process now and add a version-agnostic pass-through regression: RED on the old override (`true !== Core undefined`), GREEN after deletion.
- [ ] After #31 is accepted/published, pin Bot to the new artifact and verify Core itself supplies compact GFM tables.

## Task 2 — Persistent reasoning contract

**Files:** `src/bot/messages/thinking-rendering.ts`, `src/bot/services/event-subscription-service.ts`, related tests.

- [x] Remove short/long completion fork.
- [x] Persist every completed visible reasoning section as `expandable_blockquote`.
- [x] Keep live reasoning independent from final answer.
- [x] Keep provider-private chain-of-thought outside the visible contract.
- [x] Update top-level and CI-only reasoning tests.
- [x] Re-run reasoning regression after final rebase: top-level gate green on the Core-owned pass-through branch.

## Task 3 — One run-owned Activity stream

**Files:** `src/bot/streaming/tool-call-streamer.ts`, `src/bot/services/event-subscription-service.ts`, Activity tests.

- [x] Unify default/subagent/todo stream state per session/run generation.
- [x] Keep prefix replacement/dedupe for live tool/subagent updates.
- [x] Flush rather than break Activity at reasoning/file boundaries where the same run continues.
- [x] Preserve bounded Telegram text splitting and rate-limit handling.
- [x] Final regression proves a reasoning phase followed by more tools edits the same run-owned Activity message rather than creating tool-kind-specific spam.

## Task 4 — Activity → Core-native Details

**Files:**
- `src/bot/streaming/tool-activity-renderer.ts`
- `src/bot/services/event-subscription-service.ts`
- `tests/tool-activity-renderer.test.ts`
- `tests/tool-activity-stream.test.ts`

**Interface:**

`renderToolActivity(input: string): TelegramRenderedPart`

- [x] Add RED test requiring a collapsed native Details block and secret-safe fallback.
- [x] Implement focused Activity renderer using Core `AgentDocument` + `renderTelegramRichDocument`.
- [x] Insert tool/activity body as plain AST text, never reparsed model HTML/Markdown.
- [x] Move credential redaction into the focused renderer.
- [x] Remove expandable-blockquote Activity rendering from `ToolCallStreamer`.
- [x] Keep CompactProgressStreamer independent from Activity formatting.
- [x] Wire Activity initial send through `sendRenderedBotPart`.
- [x] Wire Activity edits through `editRenderedBotPart` so rich failure degrades on the same message where possible.
- [x] Exact local CI reproduction proves rich Activity send/edit plus fallback contracts compile and pass; CI-only suite 2267/2267 green.

## Task 5 — Core-rich final-answer integration evidence

**Files:** `tests/telegram-rich-capabilities.test.ts`; product code only if a true adapter defect is exposed.

- [x] Add integration test for visible main answer + Core-native Details.
- [x] Add math and valid `tg-time` coverage.
- [x] Add reference/reference-link coverage.
- [x] Prove model-authored callback button markup does not create `callback_data`/button blocks in the default Bot pipeline.
- [x] Prove ordinary `$100` is not promoted to math.
- [x] Keep compact-table integration assertion as a cross-PR migration guard.
- [ ] After Bot pins Core #31 artifact, prove the compact-table assertion remains green with the Bot local override removed.

## Task 6 — Semantic Telegram button styles for Bot-owned controls

**Files:** `src/bot/menus/settings-menu.ts`, `tests/telegram-button-styles.test.ts`.

- [x] `Compact Context` uses `primary`.
- [x] Delete-all-memory confirmation uses `danger`.
- [x] Clear-history confirmation uses `danger`.
- [x] Factory-reset continuation/final confirmation use `danger`.
- [x] Back/Cancel/navigation remain unstyled/default.
- [x] Add regression test for style values.
- [x] Fresh typecheck verifies grammY 1.46 exposes the documented `.primary()`/`.danger()` API.

## Task 7 — Exact-topic typing

**Files:** `src/bot/services/typing-indicator-manager.ts`, `src/bot/handlers/prompt.ts`, tests.

- [x] Thread ID is stored with typing state.
- [x] `sendChatAction("typing")` includes `message_thread_id` for Forum Topics.
- [x] Existing non-Topic behavior remains valid.
- [x] Re-run final typing regression after rebase; exact-topic heartbeat test passes.

## Task 8 — Remote Topic RPC and non-responsive Topic fixes

**Files:** `src/control-plane/topic-sdk-adapter.ts`, `src/infrastructure/node-transport.ts`, tests.

- [x] Route provider/model catalog reads through Worker/Core RPC.
- [x] Route agents and commands through Worker/Core RPC.
- [x] Route `permission.list/reply` and question rejection safely.
- [x] Preserve session/generation/directory fencing; do not fabricate empty permission state.
- [x] Re-run distributed-boundary and Remote Topic tests on final local head; top-level regression gate is green.

## Task 9 — Governed Context Compaction

**Files:** Settings/context callbacks, Remote adapter/event bus, tests.

- [x] Add `Compact Context` UI to Context Health.
- [x] Map remote SDK `session.summarize` to Worker/Core `session.compact` using the exact governed run identity.
- [x] Wait for exact-session `session.compacted` before reporting success.
- [x] Fail on session error/premature termination instead of synthesizing success.
- [x] Keep Core/OpenCode as owner of compaction semantics.
- [x] Re-run compaction/Context Health tests on final local head; Context Compact UI/RPC regressions are green.

## Task 10 — Documentation/evidence gate

- [x] Bot ownership spec explicitly links Core PR #31.
- [x] Capability matrix names the owner of each rich feature.
- [x] Security/fallback/non-goal decisions documented.
- [x] Arbitrary text color documented as unsupported by Telegram Bot API.
- [ ] Update #191 body with final changed-file map and Core artifact/version.
- [ ] Add exact final Bot commit SHA and GitHub Actions run ID.
- [ ] Add exact final test counts for top-level and CI-only suites.
- [ ] Add Core #31 final commit/CI/artifact evidence.

## Task 11 — Final verification

On the final rebased head:

- [x] `npm ci`
- [x] pinned Core-package verification (`pre.34`; semantic pass-through remains version-agnostic until #31 is published)
- [x] top-level regression suite: **290/290**
- [x] CI-only Vitest suite: **2267/2267**
- [x] `npm run lint`
- [x] `npm run typecheck`
- [x] `npm run build`
- [x] `git diff --check`
- [ ] inspect full PR diff for secrets/generated files/duplicate parser logic
- [ ] GitHub Actions conclusion = `success`
- [ ] PR `mergeable=true`
- [ ] independent Codex/strong-model review after both PRs are complete

## Required merge/release order

1. Review and accept Core PR #31.
2. Publish/pin a Core/native-runtime artifact containing #31.
3. Update Bot #191 dependency to that exact artifact.
4. Remove Bot's temporary compact-table post-process.
5. Re-run full Bot verification.
6. Only then consider #191 merge/deploy.

This order prevents a temporary regression where Bot removes the compatibility override before Core owns the same policy.
