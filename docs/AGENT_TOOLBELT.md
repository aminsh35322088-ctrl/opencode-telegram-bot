# OpenCode Agent Toolbelt

This repository ships a focused agent toolbelt for the Railway runtime. OpenCode's built-in `bash`, `read`, `write`, `edit`, `grep`, `glob`, `webfetch`, `websearch`, and experimental `lsp` tools remain available; the files under `.opencode/tools/` add structured capabilities on top.

## Built-in capabilities

- **Web Search / Web Fetch** — current web research and URL retrieval. `websearch` requires an OpenCode/Go provider or the corresponding Exa/Parallel environment flag.
- **LSP / code intelligence** — definitions, references, symbols, hover and call hierarchy when a matching language server is available.
- **Shell / filesystem / Git / GitHub** — existing OpenCode and runtime toolchain.

## Custom tools

| Tool | Purpose | Permission |
|---|---|---|
| `browser` | Playwright browser automation: navigation, snapshots, clicks, forms, screenshots, tabs, console and network inspection | ask |
| `network-diagnostics` | DNS, HTTP and TCP connectivity checks | allow |
| `system-diagnostics` | CPU, RAM, uptime, disk and process inspection | allow |
| `database-query` | Read-only SQLite queries and schema inspection | ask |
| `logs-observability` | Search recent runtime/application logs | allow |
| `image-inspect` | Inspect image format, dimensions, colorspace and metadata | allow |
| `send-file` | Deliver generated artifacts to Telegram | existing |
| `railway` | Structured Railway project, deployment, environment and log operations | allow |
| `safe-download` | Bounded file retrieval for supported user-requested downloads | allow |
| `session-recovery` | Diagnose and recover stalled OpenCode sessions | allow |
| `full-diagnostics` | Combined runtime/session diagnostics | allow |

## Browser runtime

The Docker image installs `@playwright/cli` and Chromium. Browser binaries are kept outside the application bundle at `/opt/ms-playwright`; the persistent Railway volume is used for OpenCode state and workspace data.

The browser tool is approval-gated because it can interact with external websites and can upload files or preserve browser state.

## Database scope

`database-query` is intentionally SQLite and read-only. PostgreSQL/Redis access should be added later through dedicated integrations or MCP servers rather than embedding credentials into the local tool bundle.

## Cloud integrations

Railway, Cloudflare, Vercel and other cloud APIs are intentionally handled through Settings → Integrations, where credentials can be stored and switched independently, just like GitHub.

## Dependency and validation policy

The Railway runtime has no custom package-management capability. Dependency changes are made in source control and resolved during the GitHub Actions / container build process; the running bot must not install, update, remove, or execute packages on demand.

Validation is owned by GitHub Actions. The production runtime does not ship the CI-only test suite or local validation toolchain.
