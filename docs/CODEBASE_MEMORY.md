# Codebase Memory MCP

The Railway runtime includes [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) as a local OpenCode MCP server and exposes its optional 3D graph as a Telegram Mini App.

## What it adds

Codebase Memory is a code-intelligence layer, not a replacement for the bot's existing persistent memory. The existing bot memory stores bounded user/project context separately; Codebase Memory maintains a structural code index for navigation and impact analysis.

The existing memory implementation is independent: it stores up to 500 memory items in the runtime app home and injects only a bounded relevant subset into prompts. Codebase Memory does not read, replace, or migrate that store.

Typical questions that benefit from the MCP include:

- Which functions/classes call this symbol?
- What is the execution path from a Telegram update to model execution?
- What will be affected if a router/provider/session component changes?
- Which code appears unused or disconnected?
- Where are the architectural boundaries and HTTP/cross-service links?

## Railway layout

```text
Railway container
├── Telegram bot
├── Code Graph Web App (PORT)
│   └── auth gate + reverse proxy
├── OpenCode
├── codebase-memory-mcp (MCP sessions)
├── codebase-memory-mcp (UI process, 127.0.0.1:9749)
└── /data
    ├── workspace/                       # persistent main workspace
    ├── opencode/topic-workspaces/       # isolated Telegram Topic workspaces
    └── .cache/codebase-memory-mcp/      # persistent graph/cache
```

The bot creates isolated persistent workspaces for Telegram Topics under `/data/opencode/topic-workspaces`. The MCP configuration therefore intentionally does not hard-code `/data/workspace` as its working directory; the OpenCode workspace remains the default working directory for the local MCP process.

The MCP is started by OpenCode using the local stdio transport. The graph UI is started separately by the bot runtime using the same pinned binary and persistent cache, bound only to `127.0.0.1:9749`. It is never exposed directly to the Internet.

## Telegram Mini App

The main and Topic keyboards include a `🧠 Code Graph` Web App button when a public HTTPS URL is available. On Railway, the URL is derived automatically from `RAILWAY_PUBLIC_DOMAIN`; `CODE_GRAPH_WEB_APP_URL` can override it when a dedicated custom domain/path is preferred. Railway documents `RAILWAY_PUBLIC_DOMAIN` as the service's public domain variable. citeturn838520search0

Telegram provides Web App `initData` to the Mini App. The local web server validates that signed data against the bot token, checks freshness, and enforces the bot's existing single-user allowlist before issuing a short-lived HttpOnly session cookie. The frontend shell then redirects back to the authenticated root and the server reverse-proxies the Codebase Memory UI from `127.0.0.1:9749`.

This means a user experience of:

```text
Telegram → 🧠 Code Graph → Mini App authorization → interactive 3D knowledge graph
```

The upstream project documents the UI-enabled binary and the `--ui=true --port=9749` launch mode. citeturn652999search0

## Configuration

`opencode.json` registers the server as `codebase-memory`:

```json
{
  "mcp": {
    "codebase-memory": {
      "type": "local",
      "command": ["/usr/local/bin/codebase-memory-mcp"],
      "enabled": true,
      "timeout": 30000,
      "environment": {
        "CBM_CACHE_DIR": "/data/.cache/codebase-memory-mcp",
        "CBM_ALLOWED_ROOT": "/data"
      }
    }
  }
}
```

`CBM_ALLOWED_ROOT=/data` covers both the main persistent workspace and isolated Topic workspaces. The cache is also on the Railway volume so the graph survives container restarts and redeployments.

At container startup, the entrypoint enables automatic indexing and sets an upper bound of 50,000 files for auto-indexing.

## Version and artifact pinning

The Dockerfile pins Codebase Memory to `v0.10.8` and downloads the Linux amd64 portable **UI** archive from that immutable release. It then verifies the archive against the release's published `checksums.txt` before installation. The release is immutable and publishes dedicated UI artifacts for Linux amd64. citeturn371598search0turn652999search0

When upgrading, update `CODEBASE_MEMORY_VERSION` and the archive name together from an official release. Keep checksum verification enabled and do not switch the production image to a moving `latest` download.

## Operational notes

The UI process and MCP sessions share the Codebase Memory cache on `/data/.cache/codebase-memory-mcp`. The upstream runtime is designed so the UI is owned by its shared coordination layer and concurrent agent sessions do not start duplicate HTTP servers. citeturn652999search0turn652999search4

The UI is bound to localhost inside Railway and fronted by the bot's HTTPS web server. This avoids publicly exposing port `9749`; the upstream project has an open request specifically around remote/public host binding for deployments outside localhost. citeturn652999search8

Do not commit or continuously regenerate a graph database artifact into Git. Keep the live index in the Railway volume unless a separate, deliberate artifact workflow is introduced.

The 3D graph frontend may make runtime CDN requests for some rendering dependencies, so the Mini App's WebView needs outbound HTTPS access for those resources. citeturn652999search6

## Validation

After deployment:

1. Open the bot's `🧠 Code Graph` button from Telegram private chat.
2. Confirm the Mini App authorizes and loads the 3D graph rather than exposing port `9749` directly.
3. In a bot session, verify a structural request such as:

```text
Trace the call chain from Telegram message handling to model execution.
```

The expected behavior is that OpenCode can discover and invoke the `codebase-memory` MCP tools alongside its existing tools, while the existing persistent memory continues to work independently.
