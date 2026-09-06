# Codebase Memory MCP

The Railway runtime includes [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) as a local OpenCode MCP server.

## What it adds

Codebase Memory is a code-intelligence layer, not a replacement for the bot's existing persistent memory. The existing model-independent memory continues to store bounded user/application context under `/data`; Codebase Memory maintains a separate structural index of the workspace for code navigation and impact analysis.

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
├── OpenCode
├── codebase-memory-mcp
└── /data
    ├── workspace/                       # persistent coding workspace
    └── .cache/codebase-memory-mcp/      # persistent graph/cache
```

The MCP is started by OpenCode using the local stdio transport. It is not a second Railway service and it does not expose a public HTTP endpoint.

## Configuration

`opencode.json` registers the server as `codebase-memory`:

```json
{
  "mcp": {
    "codebase-memory": {
      "type": "local",
      "command": ["/usr/local/bin/codebase-memory-mcp"],
      "cwd": "/data/workspace",
      "enabled": true,
      "timeout": 30000,
      "environment": {
        "CBM_CACHE_DIR": "/data/.cache/codebase-memory-mcp",
        "CBM_ALLOWED_ROOT": "/data/workspace"
      }
    }
  }
}
```

`CBM_ALLOWED_ROOT` prevents indexing requests from escaping the persistent workspace. The cache is on the Railway volume so the graph survives container restarts and redeployments.

At container startup, the entrypoint enables automatic indexing and sets an upper bound of 50,000 files for auto-indexing. If that configuration step fails, the bot still starts and the MCP remains available for manual indexing.

## Version pinning

The Dockerfile pins the release to `v0.10.8` and verifies the SHA-256 of the official Linux amd64 portable archive before installing it. The archive is self-contained and runs without an additional language runtime.

When upgrading, update both `CODEBASE_MEMORY_VERSION` and `CODEBASE_MEMORY_SHA256` in `Dockerfile` from an official release asset. Do not switch this to an unpinned `latest` download in the production image.

## Operational notes

Codebase Memory is intentionally configured without its optional graph UI in Railway. This keeps the deployment headless and avoids adding an unnecessary network surface.

The upstream project performs a non-blocking GitHub release metadata check after MCP initialization. It does not upload source code or graph contents. See the upstream security documentation for the exact runtime network behavior.

Do not commit or continuously regenerate a graph database artifact into Git. Keep the live index in the Railway volume unless a separate, deliberate artifact workflow is introduced.

## Validation

After deployment, verify from the bot with a structural request such as:

```text
Trace the call chain from Telegram message handling to model execution.
```

The expected behavior is that OpenCode can discover and invoke the `codebase-memory` MCP tools alongside its existing tools, while the existing persistent memory continues to work independently.
