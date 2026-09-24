# MCP Authentication Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Complete MCP authentication in the Telegram bot with auto-detected OAuth, secure token/API-key/custom-header credentials, pre-registered OAuth client credentials, clean same-message UX, and restart-safe restoration without adding Railway variables.

**Architecture:** OAuth continues through OpenCode's native OAuth APIs. Non-OAuth secrets are encrypted in bot-owned persistent state using a key derived from the existing Telegram bot token (which is stripped from the OpenCode agent environment), then injected only into OpenCode's dynamic in-memory MCP config through `mcp.add`; no secret is written to project config, model-facing actions, or new Railway variables. Pre-registered OAuth client credentials use the same encrypted store and dynamic in-memory config. Every wizard edits the canonical General panel and uses consistent Back/Cancel/Home navigation.

**Tech Stack:** TypeScript, Node.js crypto, OpenCode SDK v2, grammY, Vitest.

**Spec:** docs/superpowers/specs/2026-09-23-mcp-auth-architecture.md

**Completion note (2026-09-23):** The follow-up audit completed the broader MCP Server rework that PR #122 originally left split between legacy CLI management and SDK auth. MCP creation/connect/disconnect/auth now use the typed OpenCode SDK path only; non-secret local/remote definitions are persisted in bot-owned state and restored on OpenCode ready, while secrets remain in the separate encrypted credential store. Legacy OpenCode config shapes are read only for migration/compatibility.

## Global Constraints
- Add no new Railway variables.
- Wizards must edit the existing canonical General panel; do not send wizard messages.
- Navigation must provide correct Back/Cancel/Home behavior.
- Keep UI copy concise, i18n-backed, and explanatory where needed; English remains the fallback dictionary.
- Raw secrets must not be returned through model-facing actions, logs, or OpenCode project config.
- OAuth remains OpenCode-native.
- Existing MCP canonical action IDs remain stable.

## Review Focus
- Bot token rotation must fail closed for encrypted MCP secrets instead of returning corrupt plaintext.
- A secure MCP restored after OpenCode restart must reconnect without persisting raw credentials into config.
- Custom header names must reject unsafe HTTP header names and newline injection.
- Same-message wizard navigation must recover correctly after stale interaction state.
- Failure paths must delete credential input messages and must not log submitted secret values.

---

### Task 1: Encrypted MCP credential store

**Files:**
- Create: src/app/services/mcp-credential-store.ts
- Modify: src/app/stores/app-state-store.ts
- Test: .github/ci-tests/tests/app/services/mcp-credential-store.test.ts

**Interfaces:**
- Produces: saveMcpCredential(record), loadMcpCredential(projectDirectory, serverName), listMcpCredentials(), removeMcpCredential(...)
- Credential modes: bearer, api-key, custom-header, oauth-client

- [x] Write failing tests for encryption-at-rest, scope separation, removal, tamper failure, and token-rotation failure.
- [x] Run targeted tests and confirm RED.
- [x] Implement AES-256-GCM encryption using a key derived from existing config.telegram.token; persist only ciphertext metadata in app-state.
- [x] Run targeted tests and confirm GREEN.
- [x] Commit.

### Task 2: Dynamic secure MCP connection service

**Files:**
- Modify: src/app/services/mcp-server-service.ts
- Test: .github/ci-tests/tests/app/services/mcp-server-service.test.ts

**Interfaces:**
- Consumes encrypted credential records.
- Produces configureSecureMcpAuth(...), restoreSecureMcpConnections(), getMcpAuthSummary(...).

- [x] Write failing tests proving bearer/API-key/custom headers and OAuth client credentials go through opencodeClient.mcp.add and not CLI/config/env.
- [x] Run targeted tests and confirm RED.
- [x] Implement dynamic in-memory MCP configs and reconnect/restore behavior.
- [x] Run targeted tests and confirm GREEN.
- [x] Commit.

### Task 3: Same-message auth wizard and navigation

**Files:**
- Modify: src/bot/commands/mcp-server-command.ts
- Modify: src/bot/callbacks/mcp-server-callback-handler.ts
- Modify: src/bot/menus/mcp-server-menu.ts
- Modify: src/bot/routers/message-router.ts
- Test: .github/ci-tests/tests/bot/commands/mcp-add-wizard-ux.test.ts
- Test: .github/ci-tests/tests/bot/callbacks/mcp-server-callback-handler.test.ts
- Test: .github/ci-tests/tests/bot/commands/mcps.test.ts

**Interfaces:**
- Auth menu: Auto/OAuth, Bearer Token, API Key, Custom Header, OAuth Client.
- Secret inputs are deleted immediately and never included in display text.
- Back returns to auth choices or server detail; Cancel returns to server detail; Home remains main:home.

- [x] Write failing UX/navigation tests first.
- [x] Run targeted tests and confirm RED.
- [x] Implement clean auth menus and input steps using only editMessageText on canonical panel.
- [x] Run targeted tests and confirm GREEN.
- [x] Commit.

### Task 4: Restart restoration and model-facing safety

**Files:**
- Modify: src/app/bootstrap/start-bot-app.ts
- Modify: src/opencode/ready-refresh.ts or focused MCP lifecycle service
- Modify if needed: .opencode/tools/bot.ts and src/app/services/agent-action-registry.ts only for non-secret status visibility
- Test: .github/ci-tests/tests/app/services/mcp-credential-restore.test.ts
- Test: existing agent-action tests

**Interfaces:**
- On OpenCode ready, secure MCP definitions are re-added from encrypted bot store.
- Model-facing MCP actions can observe status/auth mode but cannot set or retrieve secrets.

- [x] Write failing restart/safety tests.
- [x] Run targeted tests and confirm RED.
- [x] Implement ready lifecycle restoration and safety filtering.
- [x] Run targeted tests and confirm GREEN.
- [x] Commit.

### Task 5: Whole-branch verification

- [x] Run lint, typecheck, build, and full Vitest suite.
- [x] Run whole-branch review against the spec and address Critical/Important findings with tests.
- [x] Sync with latest main if needed and rerun full CI.
- [x] Verify PR mergeability.
- [x] Check Railway production logs/status; do not add or modify Railway variables.

### Task 6: Complete MCP Server management rework
(**Files:**
- Rename/replace: `mcp-catalog-*` surfaces with `mcp-server-*` services, commands, menus, callbacks, and tests.
- Create: `src/app/services/mcp-server-store.ts`
- Modify: `.opencode/tools/bot.ts`, `src/opencode/ready-refresh.ts`

**Interfaces:*)
- Normal MCP definitions are structured local/remote configs, not shell CLI strings.
- Local commands are parsed into argv without losing quoted, escaped, empty, or padded arguments.
- Remote/local definitions persist without secrets and are restored after OpenCode restart.
- Authenticated remotes overlay encrypted credentials only at runtime.
- Legacy direct `mcp[name]` and current nested `mcp.servers[name]` config shapes are read for compatibility.

- [x] Remove the `opencode mcp add` child-process path and whitespace-splitting command parser.
- [x] Route add/connect/disconnect/auth through the typed OpenCode SDK.
- [x] Persist clean non-secret MCP definitions in bot-owned state.
- [x] Backfill clean definitions from pre-existing encrypted PR #122 credentials during restore.
- [x] Restore managed definitions before secure credential overlays on every OpenCode-ready lifecycle.
- [x] Remove dead SSH action-display mappings and legacy `mcp-catalog-*` naming.
- [x] Add regression coverage for quoted argv, empty/padded args, SDK-only add, restart restore, type enrichment, and CLI-path absence.
- [x] Re-run lint, typecheck, build, targeted tests, and the full suite.
