# Legacy Telegram UI Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the pre-Cloudflare Telegram UI and interaction behavior while keeping Cloudflare as the durable control/state plane and Railway/OpenCode Core as the execution plane.

**Architecture:** Reuse the canonical UI builders and interaction semantics in `src/bot/**` through a Cloudflare adapter boundary instead of continuing to duplicate presentation logic in `src/cloudflare/bot-ui.ts`. Cloudflare continues to own webhook admission, durable callback receipts, generation fencing, secrets, state mutations, fleet lifecycle and signed Core RPC; legacy UI modules own labels, layout, menu hierarchy, navigation and panel behavior.

**Tech Stack:** TypeScript, grammY Telegram Bot API primitives, Cloudflare Workers + SQLite Durable Objects, Vitest, Railway/OpenCode Core signed RPC.

**Spec:** `docs/superpowers/specs/2026-10-08-legacy-telegram-ui-parity-design.md`

## Global Constraints

- `src/bot/**` is the canonical source of truth for Telegram presentation and interaction behavior.
- Cloudflare remains responsible for durable state, admission, secrets, provisioning, routing, retries, receipts and lifecycle coordination.
- Railway/OpenCode Core remains responsible for topic-scoped execution and governed tools/processes.
- General/All navigation must never allocate an execution Worker.
- New Chat remains lazy and provisions a dedicated Worker only when needed.
- Every Topic mutation remains actor/chat/thread/generation fenced.
- Provider/Railway/Telegram credentials remain Cloudflare-protected and are never exposed to model processes.
- Do not reintroduce container-global Tailscale, global token injection, shared mutable session state or duplicated Core execution logic.
- UI parity is higher priority than exposing newly added Cloudflare-only controls; new controls may remain hidden until they can be placed without changing the legacy UX.
- This plan restores GitHub/Tailscale UI surfaces only; unsafe or incomplete backend capability actions must report unavailable state instead of falling back to legacy global behavior.

## Review Focus

- Telegram retries or duplicate callback delivery must not create multiple canonical Main panels or repeat mutations; Task 2 adds retry/receipt tests.
- Stale Topic callbacks from a deleted/recreated generation must be rejected before any adapter mutation; Tasks 1 and 4 add generation-fence tests.
- Main/root callbacks must never accidentally target a Topic-scoped API or invoke Core RPC; Task 2 adds root-scope assertions.
- Model catalogs can change between menu rendering and selection; Task 3 adds stale/missing model selection behavior and refresh-safe tests.
- Telegram edit/pin operations can be rejected, rate-limited or ambiguous; Task 2 adds rollback/reconciliation tests that preserve the last known-good canonical panel.

---

### Task 1: Introduce the Cloudflare UI adapter boundary

**Files:**
- Create: `src/cloudflare/legacy-ui-adapter.ts`
- Modify: `src/cloudflare/bot-ui.ts`
- Modify: `src/cloudflare/control-object.ts`
- Test: `tests/cloudflare-legacy-ui-adapter.test.ts`
- Test: `tests/cloudflare-ui.test.ts`

**Interfaces:**
- Consumes: `ControlStore`, Durable Object SQL state, existing `CloudTelegram`, existing signed `rpc(topic, operation, payload)` and revision-checked global mutation callback.
- Produces: `LegacyUiAdapter` with exact methods used by later tasks:
  - `getMainStatus(): Promise<LegacyMainStatus>`
  - `getTopicSelection(topic: FleetTopic): LegacyTopicSelection`
  - `setTopicSelection(topic: FleetTopic, patch: Partial<LegacyTopicSelection>): void`
  - `getGlobalSnapshot(): { revision: number; data: Record<string, unknown> } | undefined`
  - `commitGlobal(expectedRevision: number, data: Record<string, unknown>): Promise<void>`
  - `rpc<T>(topic: FleetTopic, operation: string, payload?: unknown): Promise<T>`
  - `assertWritableTopic(topic: FleetTopic): void`
  - `getUiState<T>(key: string): T | undefined`
  - `setUiState(key: string, value: unknown): void`
  - `deleteUiState(key: string): void`

- [ ] **Step 1: Write failing adapter tests**

Add tests asserting that the adapter reads current model/agent/topic preferences from Cloudflare state, writes only the current generation, rejects a stale generation, commits globals with the expected revision and does not expose credential values.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- --run tests/cloudflare-legacy-ui-adapter.test.ts`

Expected: FAIL because `LegacyUiAdapter` does not exist.

- [ ] **Step 3: Implement `LegacyUiAdapter`**

Create `src/cloudflare/legacy-ui-adapter.ts` with the signatures above. Keep it presentation-agnostic: it may translate Cloudflare storage shapes into legacy UI view models, but it must not create Telegram keyboards or messages.

- [ ] **Step 4: Wire the adapter into `CloudBotUi` dependencies**

Modify `src/cloudflare/bot-ui.ts` and `src/cloudflare/control-object.ts` so later UI builders receive this adapter rather than reaching directly into `ControlStore`/SQL for presentation state. Preserve existing webhook actor validation, callback receipts and generation fencing.

- [ ] **Step 5: Run focused and existing Cloudflare UI tests**

Run: `npm test -- --run tests/cloudflare-legacy-ui-adapter.test.ts tests/cloudflare-ui.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

Commit message: `refactor(ui): add Cloudflare legacy UI adapter boundary`

---

### Task 2: Restore the canonical pinned Main panel and same-message navigation

**Files:**
- Modify: `src/bot/keyboards/keyboard-manager.ts`
- Modify: `src/bot/menus/inline-menu.ts`
- Modify: `src/cloudflare/bot-ui.ts`
- Create: `src/cloudflare/legacy-main-ui.ts`
- Test: `tests/cloudflare-legacy-main-ui.test.ts`
- Test: `tests/cloudflare-ui.test.ts`

**Interfaces:**
- Consumes: `LegacyUiAdapter` from Task 1, existing `buildMainStatusText` semantics, `createMainInlineKeyboard`, and `Back/Home/Close` legacy navigation rules.
- Produces:
  - `renderLegacyMainStatus(status: LegacyMainStatus): string`
  - `replaceCanonicalMainPanel(chatId: number, actorId: number): Promise<void>`
  - `editCanonicalPanel(chatId: number, threadId: number | undefined, panel: LegacyPanel): Promise<void>`
  - Durable canonical panel state keys under Cloudflare UI state rather than process-local Maps.

- [ ] **Step 1: Write failing `/start` parity tests**

Assert exact structural behavior: status heading `⚡ OpenCode Telegram`, Ready state, Bot/Core versions, model, agent, `💬 New Chat`, `🕘 History`, `⚙️ Main Settings`; exactly one canonical root panel ID is persisted; successful `/start` replaces the previous canonical panel; ordinary General navigation does not call Core RPC.

- [ ] **Step 2: Write failure-mode tests**

Cover pin failure rollback, edit rejection fallback, Telegram duplicate `/start`, stale callback rejection and ambiguous delivery preserving the last known-good canonical panel.

- [ ] **Step 3: Run focused tests and verify failure**

Run: `npm test -- --run tests/cloudflare-legacy-main-ui.test.ts tests/cloudflare-ui.test.ts`

Expected: FAIL because Cloudflare currently sends the simplified Main messages and new submenu messages.

- [ ] **Step 4: Implement canonical Main panel rendering**

Create `src/cloudflare/legacy-main-ui.ts` using legacy labels/layout from `src/bot/keyboards/keyboard-manager.ts` and `src/bot/keyboards/main-reply-keyboard.ts`. Persist the canonical Main message ID in Durable Object UI state. Do not use the old process-local settings store.

- [ ] **Step 5: Port same-message `Back/Home/Close` semantics to durable state**

Reuse the rules from `src/bot/menus/inline-menu.ts`, but persist active panel metadata in Cloudflare UI state so Worker restarts do not lose the current panel. Submenus should edit the canonical active panel whenever Telegram permits it.

- [ ] **Step 6: Replace simplified Cloudflare `/start` and General menu sends**

Modify `src/cloudflare/bot-ui.ts` so `/start`, Home, History and Main Settings enter the legacy panel flow instead of sending a simplified `OpenCode / Core <version>` message plus a second navigation message.

- [ ] **Step 7: Run tests**

Run: `npm test -- --run tests/cloudflare-legacy-main-ui.test.ts tests/cloudflare-ui.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

Commit message: `feat(ui): restore pinned legacy Main panel navigation`

---

### Task 3: Restore the real legacy Model Center

**Files:**
- Modify: `src/bot/menus/model-center-menu.ts`
- Create: `src/cloudflare/legacy-model-adapter.ts`
- Modify: `src/cloudflare/bot-ui.ts`
- Test: `tests/cloudflare-legacy-model-center.test.ts`
- Test: `tests/model-center-menu.test.ts`

**Interfaces:**
- Consumes: `LegacyUiAdapter`, Cloudflare/Core production model catalog inspection, current Topic model, global default model, durable UI state.
- Produces `LegacyModelAdapter` methods:
  - `current(topic?: FleetTopic): Promise<ModelInfo | undefined>`
  - `providers(): Promise<ProviderInfo[]>`
  - `models(providerId: string): Promise<ModelInfo[]>`
  - `favorites(scope: LegacyModelScope): Promise<ModelInfo[]>`
  - `recent(scope: LegacyModelScope): Promise<ModelInfo[]>`
  - `setFavorite(scope: LegacyModelScope, model: ModelInfo, enabled: boolean): Promise<void>`
  - `select(scope: LegacyModelScope, model: ModelInfo): Promise<void>`

- [ ] **Step 1: Write failing Model Center parity tests**

Assert root contains Current Model, Favorites, Recent models, Search models, Browse providers and Back; provider pages paginate at the existing legacy page size; selection updates Topic or global scope correctly; favorite toggles persist durably.

- [ ] **Step 2: Add catalog-race tests**

Render a model, remove it from the mocked live catalog before selection, and assert selection reports unavailable/stale rather than persisting an invalid model. Assert search/favorites tolerate providers disappearing.

- [ ] **Step 3: Run tests and verify failure**

Run: `npm test -- --run tests/cloudflare-legacy-model-center.test.ts tests/model-center-menu.test.ts`

Expected: FAIL because the legacy Model Center still depends on old local model services and Cloudflare uses its simplified flow.

- [ ] **Step 4: Add injectable model data/persistence boundary to `model-center-menu.ts`**

Keep all existing layout, labels, callbacks, Favorites/Recent/Search/Providers, pagination, capability icons and price-view formatting. Replace direct process-local reads/writes with an injected adapter when running under Cloudflare; preserve the existing default adapter for the legacy Node runtime tests.

- [ ] **Step 5: Implement `LegacyModelAdapter`**

Back it with Cloudflare canonical state and signed production model catalog inspection. Do not add hidden model fallback.

- [ ] **Step 6: Route Cloudflare Model actions into the actual legacy Model Center handlers**

Remove the duplicate simplified Model Center tree from the live Cloudflare path after parity tests pass.

- [ ] **Step 7: Run tests**

Run: `npm test -- --run tests/cloudflare-legacy-model-center.test.ts tests/model-center-menu.test.ts tests/cloudflare-ui.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

Commit message: `feat(ui): restore legacy Model Center on Cloudflare`

---

### Task 4: Restore Main Settings, Topic Settings and reply keyboard parity

**Files:**
- Modify: `src/bot/keyboards/main-reply-keyboard.ts`
- Modify: `src/bot/menus/agent-selection-menu.ts`
- Modify: `src/bot/menus/context-control-menu.ts`
- Modify: `src/bot/menus/extension-settings-menu.ts`
- Modify: `src/bot/menus/mcp-server-menu.ts`
- Modify: relevant existing Settings menu modules under `src/bot/menus/`
- Create: `src/cloudflare/legacy-settings-adapter.ts`
- Modify: `src/cloudflare/config-ui.ts`
- Modify: `src/cloudflare/bot-ui.ts`
- Test: `tests/cloudflare-legacy-settings.test.ts`
- Test: `tests/main-reply-keyboard.test.ts`

**Interfaces:**
- Consumes: revisioned global snapshot mutation, Topic-scoped UI preferences, provider credential protected flow and existing callback fencing.
- Produces `LegacySettingsAdapter` methods for reading the legacy Settings view model and applying revision-checked global or generation-checked Topic mutations.

- [ ] **Step 1: Write failing Main Settings hierarchy tests**

Assert the Cloudflare live path exposes the same legacy hierarchy and labels for default model/configuration, Providers, GitHub, Tailscale, Extensions, Actions, MCP/Skills/custom commands and existing advanced/settings sections. GitHub/Tailscale actions with no safe adapter must render explicit unavailable/not-connected state and must not invoke legacy global token/daemon code.

- [ ] **Step 2: Write failing Topic keyboard/settings tests**

Assert idle/running/paused reply keyboard labels and row layout match legacy behavior, active Topic model label is shown, and Topic Settings expose Agent, Variant, Session/Context/Files/queue/output controls through legacy menu semantics.

- [ ] **Step 3: Add stale generation mutation tests**

Create generation 1 callback, rotate Topic to generation 2, invoke the generation 1 Settings callback and assert no state changes and no Core RPC occurs.

- [ ] **Step 4: Run focused tests and verify failure**

Run: `npm test -- --run tests/cloudflare-legacy-settings.test.ts tests/main-reply-keyboard.test.ts`

Expected: FAIL because Cloudflare hard-codes a simplified Settings tree.

- [ ] **Step 5: Implement `LegacySettingsAdapter` and injectable legacy menu data sources**

Use Cloudflare canonical snapshot and Topic options. Preserve existing legacy menu copy/layout/callback semantics; do not duplicate them in `src/cloudflare/config-ui.ts`.

- [ ] **Step 6: Route Main/Topic Settings and reply keyboards through legacy builders**

Keep Cloudflare callback receipt/generation checks around the legacy handlers. Remove the corresponding duplicate Cloudflare menu rows after tests pass.

- [ ] **Step 7: Run tests**

Run: `npm test -- --run tests/cloudflare-legacy-settings.test.ts tests/main-reply-keyboard.test.ts tests/cloudflare-ui.test.ts tests/cloudflare-config-ui.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

Commit message: `feat(ui): restore legacy Settings and Topic controls`

---

### Task 5: Restore Session, Context and Files presentation on signed Core RPC

**Files:**
- Modify: `src/bot/menus/message-history-menu.ts`
- Modify: `src/bot/menus/file-browser-menu.ts`
- Modify: `src/bot/menus/context-control-menu.ts`
- Modify: other existing session/todo/diff/sub-agent menu modules used by the legacy UI
- Create: `src/cloudflare/legacy-session-adapter.ts`
- Modify: `src/cloudflare/bot-ui.ts`
- Test: `tests/cloudflare-legacy-session-ui.test.ts`
- Test: existing file/session/context menu tests

**Interfaces:**
- Consumes: `LegacyUiAdapter.rpc<T>()` and Core capability/version gates.
- Produces `LegacySessionAdapter` methods:
  - `session(topic): Promise<unknown>`
  - `messages(topic): Promise<unknown[]>`
  - `context(topic): Promise<unknown>`
  - `todos(topic): Promise<unknown[]>`
  - `diff(topic): Promise<unknown>`
  - `children(topic): Promise<unknown[]>`
  - `childMessages(topic, childId): Promise<unknown[]>`
  - `list(topic, path): Promise<unknown>`
  - `read(topic, path): Promise<unknown>`
  - `download(topic, path): Promise<LegacyDownload>`
  - `compact(topic, requestId): Promise<void>` only when both control/core runtime support the capability.

- [ ] **Step 1: Write failing presentation parity tests**

Assert Session, Message History, Context, Todos, Diff, Files and child-sub-agent views use legacy menu labels/navigation and same-message editing while data is sourced from RPC fixtures.

- [ ] **Step 2: Write capability/fencing tests**

Assert context compaction is hidden when the runtime version is below the supported floor, stale Topic generations reject all RPC, and file paths remain bounded/relative.

- [ ] **Step 3: Run tests and verify failure**

Run: `npm test -- --run tests/cloudflare-legacy-session-ui.test.ts`

Expected: FAIL because Cloudflare currently formats these views itself.

- [ ] **Step 4: Add injectable data boundary to the legacy session/file/context menu modules**

Preserve layout/navigation. Replace local runtime reads with `LegacySessionAdapter` only when the Cloudflare adapter is provided.

- [ ] **Step 5: Route Cloudflare actions to legacy session/file/context handlers**

Keep signed RPC and generation verification in the Cloudflare adapter, not inside presentation builders.

- [ ] **Step 6: Run focused tests**

Run: `npm test -- --run tests/cloudflare-legacy-session-ui.test.ts tests/cloudflare-ui.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

Commit message: `feat(ui): restore legacy session context and files panels`

---

### Task 6: Remove duplicate Cloudflare presentation paths and verify the live migration

**Files:**
- Modify: `src/cloudflare/bot-ui.ts`
- Modify: `src/cloudflare/config-ui.ts`
- Modify: `docs/cloudflare/ui-migration-status.md`
- Test: `tests/cloudflare-ui.test.ts`
- Test: `tests/cloudflare-production.test.ts`
- Test: all legacy menu/keyboard tests affected by Tasks 2-5

**Interfaces:**
- Consumes: all adapters and legacy UI paths from Tasks 1-5.
- Produces: a Cloudflare UI entrypoint that owns admission/state/transport but no longer independently defines duplicate Model Center, Settings, Session/Files or navigation presentation trees.

- [ ] **Step 1: Add regression assertions that duplicate simplified flows are unreachable**

Assert `/start` never emits the simplified `OpenCode\nCore <version>` panel, Model Center is not generated from Cloudflare hard-coded rows, and Settings/Session navigation enters legacy builders.

- [ ] **Step 2: Remove superseded Cloudflare presentation branches**

Delete only duplicate user-facing layout/label/menu code that has an active tested legacy replacement. Keep callback receipt validation, protected form handling, task/config backend services and Cloudflare-specific transport/state code.

- [ ] **Step 3: Run formatting/type/lint/build and targeted tests**

Run:
- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm test -- --run tests/cloudflare-legacy-ui-adapter.test.ts tests/cloudflare-legacy-main-ui.test.ts tests/cloudflare-legacy-model-center.test.ts tests/cloudflare-legacy-settings.test.ts tests/cloudflare-legacy-session-ui.test.ts tests/cloudflare-ui.test.ts tests/cloudflare-production.test.ts`

Expected: all PASS.

- [ ] **Step 4: Run the complete repository test suite**

Run: `npm test -- --run`

Expected: all tests PASS with no new failures.

- [ ] **Step 5: Commit source cleanup**

Commit message: `refactor(ui): make legacy Telegram UI canonical on Cloudflare`

- [ ] **Step 6: Deploy the Cloudflare control plane from the tested main commit**

Verify the deployment reports the expected source commit/version and retains existing Durable Object/Queue bindings and protected secrets.

- [ ] **Step 7: Live Telegram acceptance test**

In the real forum group:
- run `/start` and verify one rich pinned canonical Main panel;
- open Home/History/Main Settings and confirm same-message navigation;
- open the real legacy Model Center and exercise Favorites/Recent/Search/Providers;
- open GitHub/Tailscale UI surfaces and confirm safe status behavior;
- create/open a Topic and verify idle/running/paused reply keyboard and Topic Settings;
- open Session/Context/Files;
- execute one real model/tool request through Railway/Core and verify running→idle UI transition.

- [ ] **Step 8: Inspect Cloudflare and Railway logs**

Expected: no unhandled callback errors, no stale-generation mutations, no unexpected Worker allocations from General navigation, no duplicate response delivery, and the real model/tool run completes with positive Railway runtime logs.

- [ ] **Step 9: Iterate fixes and repeat Steps 3-8 until clean**

Do not mark the migration complete while a live UI regression, failing test or runtime/control-plane error remains.

- [ ] **Step 10: Update migration status documentation**

Record the exact tested/deployed Bot commit, Core version/image, live UI acceptance results and any remaining non-UI capability gaps.

- [ ] **Step 11: Final commit**

Commit message: `docs(ui): record verified legacy Telegram UI parity`
