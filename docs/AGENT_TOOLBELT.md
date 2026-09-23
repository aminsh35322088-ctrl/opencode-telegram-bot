# OpenCode Agent Toolbelt

The model-facing tool surface is standardized around **canonical actions**. OpenCode native tools keep their native schemas, while repository custom tools expose an explicit `action` argument. The `actions` tool is the discovery layer for both.

## Discovery

Use:

- `actions(action="list")` to discover canonical actions.
- `actions(action="describe", id="tool.action")` to inspect metadata.
- `actions(action="resolve", id="tool.action")` to get the exact invocation target.
- `actions(action="summary")` for counts by source/category/risk.
- `actions(action="sources")` to understand static vs dynamic action sources.

Every registry entry includes a source, category, risk classification, description, and invocation metadata.

## Action sources

### OpenCode native tools

Canonical IDs cover native OpenCode capabilities such as `bash.exec`, `read.read`, `write.write`, `edit.edit`, `apply_patch.apply`, `grep.search`, `glob.search`, `webfetch.fetch`, `websearch.search`, `lsp.query`, `todowrite.update`, `task.delegate`, `question.ask`, and `skill.load`.

These are registry aliases for discovery only; the model still invokes the native OpenCode tool with its native schema.

### Repository custom tools

| Tool | Main action families |
|---|---|
| `actions` | catalog list/describe/resolve/source/summary |
| `bot` | projects, worktrees, models, agents, variants, skills, commands, MCP, sessions, scheduled tasks, safe settings, memory, provider metadata, GitHub/Railway account metadata, versions |
| `media` | STT status/transcription and configured Image Chat generation/editing |
| `browser` | navigation, snapshots, screenshots, interaction, tabs, console/network inspection, PDF |
| `network-diagnostics` | DNS, HTTP, TCP |
| `system-diagnostics` | summary, process, disk inspection |
| `full-diagnostics` | quick/full bounded runtime checks |
| `database-query` | read-only SQLite query |
| `logs-observability` | bounded log search |
| `image-inspect` | image format/dimensions/colorspace/metadata |
| `safe-download` | bounded HTTP(S) download into the active worktree |
| `send-file` | Telegram artifact delivery |
| `github-ci` | workflow status/watch/logs/verification |
| `railway` | project/status/log/variable/deploy operations |
| `ssh` | direct/Cloudflare remote exec, file read/write/transfer, persistent public-key identity |
| `storage-health` | persistent-volume inspection and safe cache cleanup |
| `session-recovery` | inspect/abort/continue stalled OpenCode sessions |

All custom tools use an explicit `action` discriminator, including formerly single-purpose tools.

### Dynamic MCP tools

MCP servers are runtime-defined. Their tool names and schemas are intentionally **not** hard-coded into the static registry. When an MCP server is connected, OpenCode exposes its tools directly to the model. `bot.mcp.*` actions manage connection metadata and state; the server-provided tools remain dynamic.

## Bot control-plane boundaries

The `bot` tool exposes capabilities that are useful to an autonomous coding agent without exposing stored credentials. It can inspect or switch existing model/agent/variant selections, manage scheduled tasks, safe settings, skills, MCP state, memory, and existing GitHub/Railway account selections.

Credential enrollment remains UI-only. API keys and GitHub/Railway/Cloudflare Access credentials are never returned by model-facing actions and are not accepted as tool arguments. The `ssh` tool loads the selected Cloudflare Service Token internally and only exposes the bot-owned public SSH key.

## Media actions

The `media` tool reuses the bot's configured AI connections instead of asking the model for credentials. Audio transcription reads a bounded file inside the active worktree. Image generation/editing uses the resolved default Image Chat profile and writes the resulting image back into the active worktree.

## Risk metadata vs runtime permissions

Registry risk metadata (`read`, `write`, `external`, `mutating`, `destructive`) helps the agent and future policy layers reason about side effects. It does **not** replace OpenCode's runtime permission configuration. Runtime permission rules remain authoritative.

## Runtime dependency policy

Railway is production only. Dependency changes are made in source control and resolved by the normal GitHub/container build. The running bot must not mutate its application dependency graph on demand.
