# Telegram-Native Presentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish PR #191 as a Telegram-native OpenCode client: persistent reasoning, one collapsible run Activity surface, modern Rich Message rendering, exact-topic typing, governed context compaction, and complete audit documentation without changing final-answer semantics or run ownership.

**Architecture:** Core `v1.18.33-bot.13-pre.34` remains the authoritative Markdown/Rich Message parser and renderer. The Bot adds only Bot-owned presentation behavior: trusted Activity `details` delivery/fallback, deterministic keyboard styles, integration tests proving Core rich capabilities through `renderTelegramParts()`, and preservation of the already-implemented reasoning/typing/Remote Topic/compaction fixes. No parallel rich grammar is introduced in the Bot.

**Tech Stack:** TypeScript, grammY 1.46, Telegram Bot API 10.1–10.3 Rich Messages, `@opencode-telegram/native-runtime` pre.34, Node test runner, Vitest CI.

**Spec:** `docs/superpowers/specs/2026-10-14-telegram-native-presentation-design.md`

## Global Constraints

- Final answer stays separate from reasoning and Activity; existing final-answer generation/finalization semantics must not change.
- Every completed visible reasoning section persists as Telegram `expandable_blockquote`; there is no short/long threshold.
- Activity is one run-owned surface across default/subagent/todo/tool phases and is collapsed by default with native `details`.
- Activity rich and fallback forms must redact token/API-key/password/secret/credential-shaped values and must not embed unbounded raw output.
- Model-authored final answers use Core's allowlisted parser; Bot must not enable `allowInteractiveButtons` or accept raw Bot API objects from model output.
- Rich feature failure must degrade to complete visible fallback text; no summary/body/action history may disappear.
- Exact-topic `typing...`, Stop ownership, Remote Topic fencing and governed context compaction remain intact.
- No custom text-color syntax is introduced; Telegram owns theme colors.
- No merge or production deploy is part of this plan.
- PR documentation must stay synchronized with implementation and final CI evidence.

## Review Focus

- A rich Activity send succeeds but a later rich edit fails: the existing message must remain owned by the same run and receive a readable text fallback without creating per-tool message spam.
- Malformed/unclosed model-authored rich HTML must remain visible and must not make the final answer disappear or enable an interactive action.
- Persian/RTL text nested inside Details, tables and code must keep direction handling and chunking guarantees.
- Secret-shaped values mixed with long Shell/tool output must be redacted before both rich rendering and fallback, and message limits must remain bounded.
- Model output containing `tg-button`/button markup must not create callbacks, URLs, Mini App launches or destructive actions while bot-owned deterministic controls may use Telegram styles.

---

### Task 1: Rebase #191 and re-establish a trustworthy baseline

**Files:**
- Existing branch only; no product-code file is intentionally changed by this task.
- Verify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: current `main` and `feat/native-run-presentation`.
- Produces: a conflict-free feature branch on the latest `main`, with the previously completed #191 behavior still green before new product changes.

- [ ] **Step 1: Rebase the feature branch onto current `origin/main`**

Run: `git fetch origin main && git rebase origin/main`

Expected: clean rebase or conflicts resolved without dropping #191 reasoning/typing/Remote Topic/compaction changes.

- [ ] **Step 2: Install exactly the branch dependencies and verify pinned Core artifacts**

Run: `npm ci && node scripts/verify-core-install.mjs`

Expected: both commands exit 0 and Core/native-runtime resolves to `v1.18.33-bot.13-pre.34` unless `main` intentionally advanced the pin.

- [ ] **Step 3: Run the pre-change top-level regression gate**

Run: `node --import tsx --test tests/*.test.ts`

Expected: PASS. Any failure caused by the rebase is fixed before Task 2.

- [ ] **Step 4: Commit only conflict-resolution changes if the rebase required semantic edits**

Commit message: `chore: rebase native presentation on latest main`

---

### Task 2: Replace Activity expandable quote with native Rich Details and content-preserving fallback

**Files:**
- Create: `src/bot/streaming/tool-activity-renderer.ts`
- Create: `src/bot/services/rich-activity-delivery.ts`
- Modify: `src/bot/streaming/tool-call-streamer.ts`
- Modify: `src/bot/services/event-subscription-service.ts`
- Test: `tests/tool-activity-stream.test.ts`
- Create test: `tests/rich-activity-delivery.test.ts`
- Modify CI mirror: `.github/ci-tests/tests/bot/streaming/tool-call-streamer.test.ts`

**Interfaces:**
- Consumes: the existing aggregated text state from `ToolCallStreamer`; session-scoped grammY `Api` used by `event-subscription-service.ts`.
- Produces: `renderToolActivity(input: string): ToolActivityPayload`, where `ToolActivityPayload = { richMessage: InputRichMessageWithoutUpload; fallbackText: string; actionCount: number }`; `sendRichActivity(...)` and `editRichActivity(...)` helpers that return/retain the persistent Telegram message ID.

- [ ] **Step 1: Write failing renderer tests**

Add assertions that `renderToolActivity("🔎 Grep …\n\n💻 Shell …")` returns exactly one `details` block, omits `is_open`, uses summary `🛠 Activity · 2 actions`, preserves ordered body text, and removes credential values from both `richMessage` and `fallbackText`.

Run: `node --import tsx --test tests/tool-activity-stream.test.ts`

Expected: FAIL because Activity still renders as expandable quote/entity text.

- [ ] **Step 2: Implement `renderToolActivity(input: string): ToolActivityPayload` in `tool-activity-renderer.ts`**

Use one `details` block with a short summary and a paragraph body; count non-empty logical Activity entries; reuse the existing redaction patterns; omit `is_open` so Telegram collapses it by default. Keep the fallback as `summary + blank line + redacted body`.

- [ ] **Step 3: Write failing rich delivery/fallback tests**

Test initial `sendRichMessage`, subsequent rich edit through `api.raw.editMessageText({ chat_id, message_id, rich_message })`, Topic/session-scoped options, rich-send failure → text send, and rich-edit failure → edit the same message ID with fallback text rather than sending a new per-tool message.

Run: `node --import tsx --test tests/rich-activity-delivery.test.ts`

Expected: FAIL because no focused rich Activity delivery helper exists.

- [ ] **Step 4: Implement rich Activity delivery**

Create:

`sendRichActivity(api: Api, chatId: number, payload: ToolActivityPayload, options?: { messageThreadId?: number }): Promise<number>`

`editRichActivity(api: Api, chatId: number, messageId: number, payload: ToolActivityPayload): Promise<void>`

Use grammY `api.sendRichMessage(chatId, payload.richMessage, options)` for the first send and `api.raw.editMessageText({ chat_id: chatId, message_id: messageId, rich_message: payload.richMessage })` for edits so no legacy text parameter is required. Preserve `disable_notification` on initial delivery and explicit Topic/thread routing. On rich API failure, fall back to plain `sendMessage`/`editMessageText` without changing message ownership.

- [ ] **Step 5: Wire `event-subscription-service.ts` to the new payload/delivery helpers**

The existing `ToolCallStreamer` aggregation/dedupe rules remain authoritative; only presentation/delivery changes. Reasoning start must continue to `flushSession`, not break/reset the Activity message.

- [ ] **Step 6: Run Activity tests and CI-mirror tests**

Run: `node --import tsx --test tests/tool-activity-stream.test.ts tests/rich-activity-delivery.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

Commit message: `feat: render run activity as Telegram details`

---

### Task 3: Prove Core-native final-answer capabilities through the Bot pipeline without duplicating grammar

**Files:**
- Modify only if a test exposes an adapter bug: `src/bot/render/pipeline.ts`
- Create: `tests/telegram-rich-capabilities.test.ts`
- Add CI mirror coverage under: `.github/ci-tests/tests/bot/render/telegram-rich-capabilities.test.ts`

**Interfaces:**
- Consumes: `renderTelegramParts(markdown: string, options?: TelegramChunkerOptions): TelegramRenderedPart[]` and Core pre.34's `parseMarkdownDocument` / `renderTelegramRichDocument` behavior.
- Produces: integration evidence that Bot output preserves Core-native `details`, `date_time`, math, anchor/reference and compact-table semantics while interactive buttons remain disabled.

- [ ] **Step 1: Add end-to-end Rich Details tests**

Input includes visible main text followed by `<details><summary>Technical details</summary>` containing Markdown, code, a list and a table. Assert the main paragraph stays visible, one native `details` block exists, its body remains structured, and fallback text contains summary and body.

- [ ] **Step 2: Add malformed/nested/RTL Details tests**

Assert malformed/unclosed markup remains visible, valid nesting remains within existing chunking limits, and Persian/RTL content does not disappear or corrupt the Rich Message.

- [ ] **Step 3: Add date/time, math, anchor/reference and currency tests**

Assert valid `<tg-time unix="1760457600" format="D">…</tg-time>` yields `date_time`; explicit/Markdown math yields `mathematical_expression`; `$100` remains ordinary text; anchors/reference links compile to native RichText; unresolved invalid constructs stay visible.

- [ ] **Step 4: Add compact-table and interactive-button security tests**

Assert every eligible native table returned by the Bot pipeline has `is_compact: true`. Feed model-authored `tg-button` markup and assert no callback/url/web-app RichMessage button is produced because `allowInteractiveButtons` remains disabled.

- [ ] **Step 5: Run the capability suite**

Run: `node --import tsx --test tests/telegram-rich-capabilities.test.ts`

Expected: PASS with no Bot-local parser extension. If a failure is a Bot adapter defect, make the smallest change in `pipeline.ts`; do not add a duplicate parser.

- [ ] **Step 6: Commit**

Commit message: `test: prove Telegram rich answer capabilities`

---

### Task 4: Apply Telegram button styles only to high-value bot-owned controls

**Files:**
- Modify: `src/bot/services/telegram-topic-delete-handler.ts`
- Modify: `src/bot/menus/settings-menu.ts`
- Test: existing settings routing/menu tests plus a focused delete-confirmation keyboard test under `tests/`.
- Mirror relevant tests in `.github/ci-tests/tests/` if the CI suite owns that contract.

**Interfaces:**
- Consumes: grammY `InlineKeyboard.text(...).danger()/.success()/.primary()` APIs and existing callback constants.
- Produces: presentation-only styles; callback strings and routing behavior remain byte-for-byte unchanged.

- [ ] **Step 1: Write failing style tests**

Assert `🗑 Delete permanently` is `danger`; Cancel/Back remain neutral; `🧠 Compact Context` is `primary`; use `success` only on an existing explicit positive confirmation button if one exists after the rebase.

- [ ] **Step 2: Apply deterministic styles**

Use grammY `.danger()`, `.primary()` and `.success()` only after the intended bot-owned button. Do not style every navigation control and do not add new callbacks.

- [ ] **Step 3: Run menu/callback regression tests**

Run the affected top-level tests and the matching CI-only tests.

Expected: PASS; callback_data values are unchanged.

- [ ] **Step 4: Commit**

Commit message: `feat: style bot-owned Telegram actions`

---

### Task 5: Re-verify carried-forward #191 lifecycle fixes after Telegram presentation changes

**Files:**
- Verify/modify only on regression: `src/bot/messages/thinking-rendering.ts`, `src/bot/services/typing-indicator-manager.ts`, `src/bot/handlers/prompt.ts`, `src/control-plane/topic-sdk-adapter.ts`, `src/infrastructure/node-transport.ts`, `src/bot/callbacks/context-control-callback-handler.ts`, `src/bot/callbacks/settings-callback-handler.ts`, `src/opencode/topic-event-bus.ts`.
- Tests: `tests/thinking-rendering.test.ts`, `tests/typing-indicator-manager.test.ts`, `tests/core-topic-sdk-adapter.test.ts`, existing compaction/Remote Topic tests.

**Interfaces:**
- Consumes: completed reasoning renderer, exact Topic thread ID, Worker/Core RPC surface and `session.compacted` event.
- Produces: proof that presentation work did not regress the already-approved run lifecycle.

- [ ] **Step 1: Verify completed reasoning is always expandable and separate**

Run reasoning tests; assert no 320-character/4-line branch returns.

- [ ] **Step 2: Verify exact-topic typing heartbeat**

Assert `sendChatAction("typing")` carries the active `message_thread_id` and stops on run completion/cancel.

- [ ] **Step 3: Verify Remote Topic SDK and context compaction**

Assert provider/agent/command/permission/question RPCs remain governed and `session.summarize` completes only on the exact session's real `session.compacted` event.

- [ ] **Step 4: Run targeted lifecycle gate**

Run: `node --import tsx --test tests/thinking-rendering.test.ts tests/typing-indicator-manager.test.ts tests/core-topic-sdk-adapter.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit only if regressions required fixes**

Commit message: `fix: preserve run lifecycle under rich presentation`

---

### Task 6: Complete reviewer-facing documentation with implementation evidence

**Files:**
- Modify: `docs/superpowers/specs/2026-10-14-telegram-native-presentation-design.md`
- Modify: `docs/superpowers/plans/2026-10-14-telegram-native-presentation.md`
- Modify: PR #191 body through GitHub connector.

**Interfaces:**
- Consumes: final implementation and tests from Tasks 1–5.
- Produces: self-contained audit trail for Codex/strong-model review.

- [ ] **Step 1: Mark completed plan checkboxes only after their tests are green**

Do not mark verification tasks complete from intent alone.

- [ ] **Step 2: Add an implementation/evidence section to the spec**

Record which capabilities are Core pre.34-owned versus Bot-owned, exact fallback behavior, security gates, known Telegram client limitations, and any deviations from the approved design.

- [ ] **Step 3: Update the PR body**

Include capability matrix summary, changed files by responsibility, test counts, final commit SHA, final GitHub Actions run ID, and explicit non-goals. Keep historical earlier CI evidence labeled historical.

- [ ] **Step 4: Commit documentation**

Commit message: `docs: record Telegram-native implementation evidence`

---

### Task 7: Full regression, CI, and final double-check

**Files:**
- No intended product changes unless verification finds a defect.

**Interfaces:**
- Consumes: complete feature branch from Tasks 1–6.
- Produces: mergeable, fully documented PR #191 with fresh local and GitHub CI evidence.

- [ ] **Step 1: Run the exact top-level CI boundary gate**

Run: `node --import tsx --test tests/*.test.ts`

Expected: all top-level tests PASS.

- [ ] **Step 2: Materialize and run the CI-only suite exactly like `.github/workflows/ci.yml`**

Run the workflow sequence: install Vitest 3.2.4 without lockfile mutation, materialize `.github/ci-tests/tests`, then `npm run lint`, `npm run typecheck`, `npm run build`, and `./node_modules/.bin/vitest run --config .github/ci-tests/vitest.config.ts`.

Expected: all PASS.

- [ ] **Step 3: Run `git diff --check` and inspect the full PR diff**

Verify no generated `dist`, runtime artifacts, credentials, lockfile drift, raw private reasoning, duplicate parser implementation, or undocumented behavior entered the PR.

- [ ] **Step 4: Rebase once more if `main` moved during implementation**

After rebase, repeat the affected/full gates; never report a stale pre-rebase green result as final evidence.

- [ ] **Step 5: Push and wait for GitHub Actions on the final head**

Use the GitHub connector for PR/CI/status inspection. Expected: final CI `conclusion=success` and PR `mergeable=true`.

- [ ] **Step 6: Final reviewer pass**

Compare spec → plan → diff → tests. Specifically re-check Activity message ownership, fallback behavior, model-button security, private reasoning isolation, exact-topic typing, context compaction, and no final-answer regression.

- [ ] **Step 7: Leave PR open**

Do not merge and do not deploy. The completed PR is handed off for independent Codex/strong-model double-check.