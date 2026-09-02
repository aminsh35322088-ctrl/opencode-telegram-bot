# OpenCode Telegram Bot — Railway Edition

A Telegram client for OpenCode designed to run continuously on Railway. It lets you control OpenCode, run coding tasks, manage sessions, switch models, browse files, configure custom OpenAI-compatible providers, manage integrations, and use a compact Telegram UI.

## Architecture

```text
Telegram
   │
   ▼
Telegram Bot
   │
   ├── OpenCode API → 127.0.0.1:4096
   ├── Custom providers → /data
   ├── Persistent memory → /data
   └── Session/runtime data → /data

Railway Volume
   └── /data
```

## Project Architecture Roadmap

The project is evolving toward a **single-deployment, project-centric coding workspace**. One Railway deployment represents one owner's workspace; Telegram chats are work threads inside that project rather than separate user-isolation domains. The Telegram `chatId` remains a transport/routing identifier, but it is not used as the ownership or persistent-state boundary.

This roadmap is intentionally implemented in small, reviewable PRs. Existing sessions, memory, provider configuration, and persistent `/data` state must be preserved throughout the migration.

### Phase 0 — Multi-User Purge

Remove remaining multi-user assumptions from the core architecture.

- Keep exactly one configured Telegram owner per deployment.
- Remove per-user/per-chat state isolation where it is not required for Telegram transport.
- Keep `chatId` only where Telegram routing/callback semantics require it.
- Remove legacy multi-user compatibility and stale state schemas safely.
- Preserve existing persistent data and migrate legacy singleton-compatible state where needed.

**Exit condition:** core services no longer model Telegram chats/users as separate application owners.

### Phase 1 — Project Architecture

Make the project/workspace the primary application boundary.

- Define a project as the repository/workspace being developed.
- Keep all chats for a project connected to the same Project Brain.
- Keep projects isolated from one another.
- Treat chats as focused work threads, conceptually similar to branches/PRs but not actual Git branches.
- Establish clear ownership of sessions, memory, files, tools, and runtime state.

**Exit condition:** the codebase has a clear project → chats → sessions relationship without reintroducing multi-user isolation.

### Phase 2 — Project Brain

Build persistent project-level memory independent of the selected AI model.

- Store architecture, decisions, capabilities, constraints, known bugs, and fixes.
- Continuously accumulate useful project knowledge.
- Make memory available across all chats belonging to the project.
- Retrieve only relevant, bounded context for each task.
- Keep memory separate from raw OpenCode session history.

**Exit condition:** switching chats or models does not lose project knowledge, while prompts remain bounded.

### Phase 3 — Project / Chat Management

Add explicit project and work-thread management to the Telegram UI.

- Create/select/rename projects.
- Create and resume focused chats.
- Show recent project activity and sessions compactly.
- Keep navigation inside editable Telegram menus where practical.
- Preserve existing sessions during migration.

**Exit condition:** users can understand and control project/chat structure without exposing implementation details.

### Phase 4 — Context Engine

Connect project memory, chat history, repository state, and current task into a bounded context pipeline.

- Determine what project knowledge is relevant to the current request.
- Combine relevant memory with the active session context.
- Avoid dumping the entire project history into every prompt.
- Make context decisions observable and debuggable.

**Exit condition:** coding requests receive the right project context with predictable token usage.

### Phase 5 — AI / Tools Architecture

Unify model and tool execution around the project-centric architecture.

- Keep coding AI as the default execution path for coding/tool requests.
- Keep Image AI an explicit mode rather than keyword-driven automatic routing.
- Route voice through STT and then into the currently active mode/model.
- Keep tool capabilities such as diagnostics, browser, files, Railway, GitHub, testing, and downloads composable.
- Keep provider/model selection independent from project memory.

**Exit condition:** AI modes and tools are explicit, composable, and do not accidentally steal unrelated prompts.

### Phase 6 — Reliability

Harden long-running agent execution and recovery.

- Add bounded timeouts and stall detection.
- Ensure busy/paused/resumed states recover cleanly.
- Keep Telegram keyboards synchronized after errors/timeouts.
- Make model/provider recovery deterministic.
- Improve structured logging and failure diagnosis.
- Test realistic multi-tool and long-running sessions.

**Exit condition:** common failures recover without leaving the bot in a stuck or inconsistent state.

### Phase 7 — Railway Production

Validate the complete architecture under the real Railway deployment.

- Preserve `/data` across deploys and restarts.
- Verify OpenCode startup/recovery.
- Verify model catalog/provider health.
- Verify Telegram routing and persistent sessions.
- Inspect build and runtime logs after every production change.
- Iterate through GitHub PR fixes until Railway logs are clean and stable.

**Exit condition:** the production deployment is healthy, persistent, observable, and ready for continued feature development.

### Development rule

For this roadmap, architectural changes should follow:

```text
Audit main
   ↓
Design exact change
   ↓
Feature/fix branch
   ↓
Implementation + tests/typecheck/build
   ↓
Pull Request → main
   ↓
Review
   ↓
Merge
   ↓
Railway deploy
   ↓
Runtime/build log verification
   ↓
Fix again if needed
```

Do not treat a PR as complete merely because it compiles. Production behavior and Railway logs are part of the acceptance criteria.

## Railway deployment

Deploy the `main` branch of:

`aminsh35322088-ctrl/opencode-telegram-bot`

Attach a persistent Railway Volume at exactly:

```text
/data
```

### Required environment variables

| Variable | Required | Description |
|---|:---:|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | Token generated by @BotFather |
| `TELEGRAM_ALLOWED_USER_ID` | ✅ | Numeric Telegram user ID allowed to use the bot |

GitHub credentials, custom AI provider keys, and other integrations are configured from Telegram and are **not** required as Railway environment variables.

### Runtime defaults

OpenCode runs locally inside the same container on `127.0.0.1:4096`. Normal Telegram polling does not require a public Railway domain or an exposed OpenCode port.

The persistent `/data` volume keeps runtime settings, provider credentials, memory, and other state across restarts and redeployments.

## Telegram UI

The persistent bottom keyboard is intentionally compact:

```text
┌──────────────────┬──────────────────┐
│ 🧠 Model         │ 💬 New Chat      │
├──────────────────┼──────────────────┤
│ 🕘 History       │ ⚙️ Settings      │
└──────────────────┴──────────────────┘
```

Advanced controls are organized inside **Settings** so the main keyboard stays uncluttered.

Settings includes model selection, Token Guard, output/streaming options, audio replies, message queue, API Providers, and Integrations.

Menus use inline buttons and edit the existing menu message whenever possible. Navigation uses **Back** for parent menus and **Close** for Settings instead of creating unnecessary Telegram messages.

### Recent chat history

`🕘 History` shows recent sessions as compact inline buttons. Selecting a chat opens a compact preview containing up to the last **10 messages** and offers:

- `✅ Continue chat` — resume the selected OpenCode session.
- `← Back` — return to the recent-chat list.

History navigation stays in the same editable menu message; it does not dump the entire conversation into Telegram.

## Custom AI providers

Open **Settings → API Providers**.

The provider wizard asks for:

1. Provider name
2. Base URL, for example `https://tabitoken.com/v1`
3. API key

The bot validates OpenAI-compatible providers, discovers their models, stores the API key separately under `/data`, generates the OpenCode provider configuration, and makes the provider available to the model picker.

API keys are never displayed by the bot. The Telegram message containing a key is deleted when Telegram permits it.

Example provider:

```text
Provider: TabiToken
Base URL: https://tabitoken.com/v1
Model: claude-opus-4-8
```

See `docs/CUSTOM_PROVIDERS.md` for provider details.

## GitHub integrations

GitHub is configured from **Settings → Integrations**.

Multiple GitHub accounts can be stored independently and the active credential can be switched without changing Railway environment variables.

The bot can use the active GitHub credential for repository operations supported by the installed GitHub integration.

## Persistent memory

Memory is intentionally independent from the selected AI model.

```text
Claude → GPT → Gemini → Claude
              │
              ▼
       same persistent memory
```

Memory is stored under `/data` and only relevant, bounded memories are injected into prompts. It is not the same thing as raw session history, so switching models does not erase it and the entire memory store is not sent on every request.

## Token Guard

Token Guard is the central place for request-cost/context protection. It is designed around the main causes of unexpected model usage:

- oversized context
- unnecessary tool context
- repeated retries
- runaway agent/tool turns
- excessive output/reasoning budgets

Prompt usage telemetry records input/output/reasoning/cache/total usage so unusually expensive requests can be diagnosed instead of guessed.

For expensive models such as Opus, avoid repeated test prompts until usage has been verified in the logs.

## Environment variables

### Telegram

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | Telegram bot token; required |
| `TELEGRAM_ALLOWED_USER_ID` | — | Allowed Telegram user ID; required |

### Bot behaviour

| Variable | Default | Description |
|---|---:|---|
| `BOT_LOCALE` | `en` | Bot locale |
| `SESSIONS_LIST_LIMIT` | `10` | Sessions shown per history page |
| `MESSAGES_LIST_LIMIT` | `10` | Messages shown per message page |
| `COMMANDS_LIST_LIMIT` | `10` | Commands/skills shown per page |
| `MODELS_LIST_LIMIT` | `10` | Providers/models shown per page |
| `TASK_LIMIT` | `10` | Maximum scheduled tasks |
| `TRACK_BACKGROUND_SESSIONS` | `true` | Track background sessions |
| `MESSAGE_FORMAT_MODE` | `markdown` | `markdown` or `raw` |
| `MESSAGE_MERGE_WINDOW_MS` | `1500` | Merge near-limit Telegram chunks |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

Optional STT, document extraction, and TTS settings are documented in `.env.example`.

## Telegram commands

| Command | Description |
|---|---|
| `/status` | Server health and current state |
| `/new` | Create a new session |
| `/abort` | Abort the current task |
| `/detach` | Detach without stopping the session |
| `/sessions` | Browse recent OpenCode sessions |
| `/messages` | Browse messages, revert, or fork |
| `/worktree` | Switch Git worktrees |
| `/open` | Browse and add a project directory |
| `/ls` | Browse, open, and download files |
| `/settings` | Open bot settings |
| `/providers` | Manage custom providers |
| `/rename` | Rename the current session |
| `/commands` | Browse custom commands |
| `/skills` | Browse OpenCode skills |
| `/mcps` | Browse MCP servers |
| `/task` | Create a scheduled task |
| `/tasklist` | List/delete scheduled tasks |
| `/opencode_start` | Start OpenCode |
| `/opencode_stop` | Stop OpenCode |
| `/help` | Show help |

The bottom keyboard is the preferred navigation surface for common actions; commands remain available for compatibility and direct access.

## Coding toolbelt

The Railway runtime image includes lightweight coding/DevOps tools used by OpenCode through its shell, including `git`, `gh`, `zip`, `unzip`, `jq`, `rg`, `tree`, `file`, `rsync`, `curl`, `wget`, `ssh`, and `ps`.

See `docs/CODING_TOOLS.md` for the full list.

## Security

- Keep `TELEGRAM_BOT_TOKEN` secret.
- Set `TELEGRAM_ALLOWED_USER_ID` to your own numeric Telegram ID.
- Custom provider API keys are stored under `/data` with restricted permissions and are not committed to Git.
- GitHub credentials configured through Integrations are stored separately from Railway environment variables.
- OpenCode is local to the container and should not be exposed publicly unless authentication and networking are intentionally configured.

## Local development

Requirements: Node.js 22.14+, OpenCode, a Telegram bot token, and your Telegram user ID.

```bash
npm ci
npm run build
npm start
```
