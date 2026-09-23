# MCP Authentication Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Complete MCP authentication in the Telegram bot with auto-detected OAuth, secure token/API-key/custom-header credentials, pre-registered OAuth client credentials, clean same-message UX, and restart-safe restoration without adding Railway variables.

**Architecture:** OAuth continues through OpenCode's native OAuth APIs. Non-OAuth secrets are encrypted in bot-owned persistent state using a key derived from the existing Telegram bot token (which is stripped from the OpenCode agent environment), then injected only into OpenCode's dynamic in-memory MCP config through `mcp.add`; no secret is written to project config, model-facing actions, or new Railway variables. Pre-registered OAuth client credentials use the same encrypted store and dynamic in-memory config. Every wizard edits the canonical General panel and uses consistent Back/Cancel/Home navigation.

**Tech Stack:** TypeScript, Node.js crypto, OpenCode SDK v2, grammY, Vitest.

**Spec:** docs/superpowers/specs/2026-09-23-mcp-auth-architecture.md

## Global Constraints
- Add no new Railway variables.
- Wizards must edit the existing canonical General panel; do not send wizard messages.
- Navigation must provide correct Back/Cancel/Home behavior.
- Keep UI copy concise, clean, English, and explanatory where needed.
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

- [ ] Write failing tests for encryption-at-rest, scope separation, removal, tamper failure, and token-rotation failure.
- [ ] Run targeted tests and confirm RED.
- [ ] Implement AES-256-GCM encryption using a key derived from existing config.telegram.token; persist only ciphertext metadata in app-state.
- [ ] Run targeted tests and confirm GREEN.
- [ ] Commit.

### Task 2: Dynamic secure MCP connection service

**Files:**
- Modify: src/app/services/mcp-catalog-service.ts
- Test: .github/ci-tests/tests/app/services/mcp-catalog-service.test.ts

**Interfaces:**
- Consumes encrypted credential records.
- Produces configureSecureMcpAuth(...), restoreSecureMcpConnections(), getMcpAuthSummary(...).

- [ ] Write failing tests proving bearer/API-key/custom headers and OAuth client credentials go through opencodeClient.mcp.add and not CLI/config/env.
- [ ] Run targeted tests and confirm RED.
- [ ] Implement dynamic in-memory MCP configs and reconnect/restore behavior.
- [ ] Run targeted tests and confirm GREEN.
- [ ] Commit.

### Task 3: Same-message auth wizard and navigation

**Files:**
- Modify: src/bot/commands/mcp-catalog-command.ts
- Modify: src/bot/callbacks/mcp-catalog-callback-handler.ts
- Modify: src/bot/menus/mcp-catalog-menu.ts
- Modify: src/bot/routers/message-router.ts
- Test: .github/ci-tests/tests/bot/commands/mcp-add-wizard-ux.test.ts
- Test: .github/ci-tests/tests/bot/callbacks/mcp-catalog-callback-handler.test.ts
- Test: .github/ci-tests/tests/bot/commands/mcps.test.ts

**Interfaces:**
- Auth menu: Auto/OAuth, Bearer Token, API Key, Custom Header, OAuth Client.
- Secret inputs are deleted immediately and never included in display text.
- Back returns to auth choices or server detail; Cancel returns to server detail; Home remains main:home.

- [ ] Write failing UX/navigation tests first.
- [ ] Run targeted tests and confirm RED.
- [ ] Implement clean auth menus and input steps using only editMessageText on canonical panel.
- [ ] Run targeted tests and confirm GREEN.
- [ ] Commit.

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

- [ ] Write failing restart/safety tests.
- [ ] Run targeted tests and confirm RED.
- [ ] Implement ready lifecycle restoration and safety filtering.
- [ ] Run targeted tests and confirm GREEN.
- [ ] Commit.

### Task 5: Whole-branch verification

- [ ] Run lint, typecheck, build, and full Vitest suite.
- [ ] Run whole-branch review against the spec and address Critical/Important findings with tests.
- [ ] Sync with latest main if needed and rerun full CI.
- [ ] Verify PR mergeability.
- [ ] Check Railway production logs/status; do not add or modify Railway variables.
