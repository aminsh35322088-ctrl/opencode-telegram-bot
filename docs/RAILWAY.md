# Railway Deployment

This fork is prepared to run as a **Telegram-first OpenCode service on Railway**.

## Architecture

```text
Telegram
   │
   ▼
Node.js bot (PID 1)
   │
   ├── Telegram Bot API
   │
   └── OpenCode SDK → http://127.0.0.1:4096
                         ▲
                         │
                  OpenCode CLI
                  `opencode serve`
```

The bot starts the local OpenCode server inside the same container when `OPENCODE_AUTO_START_IN_CONTAINER=true`. No public HTTP port is required for the bot itself.

## Required Railway variables

Set these in the Railway service Variables tab:

- `TELEGRAM_BOT_TOKEN` — token from @BotFather
- `TELEGRAM_ALLOWED_USER_ID` — your numeric Telegram user ID
- `OPENCODE_MODEL_PROVIDER` — default model provider
- `OPENCODE_MODEL_ID` — default model ID

The Railway entrypoint supplies these defaults automatically:

- `OPENCODE_API_URL=http://127.0.0.1:4096`
- `OPENCODE_AUTO_RESTART_ENABLED=true`
- `OPENCODE_AUTO_START_IN_CONTAINER=true`
- `OPENCODE_MONITOR_INTERVAL_SEC=60`
- `OPEN_BROWSER_ROOTS=/app/workspace`

If you want to override them, define the variables explicitly in Railway.

## OpenCode authentication

If the OpenCode server should use HTTP Basic Auth, set:

```text
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=<strong-password>
```

The bot reads these values and authenticates its SDK requests automatically.

## Persistent storage

Attach a Railway Volume at:

```text
/data
```

For this fork, `/app/data` is the bot's runtime home. If you use the standard Railway volume mount path `/data`, set the following variables so all persistent state is placed on the volume:

```text
OPENCODE_TELEGRAM_HOME=/data
HOME=/data
XDG_CONFIG_HOME=/data/.config
XDG_DATA_HOME=/data/.local/share
XDG_CACHE_HOME=/data/.cache
```

The repository defaults are optimized for a container-local `/app/data`; for Railway production, a volume-backed path is recommended.

## No public domain is needed

This fork is intentionally Telegram-only. Do **not** create a Railway public domain unless you have a separate reason to expose an HTTP endpoint.

The OpenCode API remains bound to `127.0.0.1:4096` and is not exposed to the Internet.

## Automatic OpenCode updates

The repository stores the currently deployed stable OpenCode version in `.opencode-version`.

`.github/workflows/opencode-update.yml` checks npm every 6 hours. When a newer `opencode-ai` stable release exists, the workflow updates `.opencode-version` and pushes a commit. Railway's GitHub deployment then rebuilds the image with the new version.

There is no manual OpenCode upgrade step.

## Resource strategy

Unlike the original source-build deployment, this image does **not** compile OpenCode from source. It installs the official `opencode-ai` npm release in the runtime image.

This removes the large OpenCode source/UI build from Railway and avoids storing build caches in the runtime volume.

Runtime caches and OpenCode state should live on the attached volume when persistence is required. Avoid storing generated build artifacts in `/data`.

## Telegram commands

The upstream bot already provides commands such as:

- `/status`
- `/new`
- `/abort`
- `/detach`
- `/sessions`
- `/messages`
- `/projects`
- `/worktree`
- `/open`
- `/ls`
- `/settings`
- `/rename`
- `/commands`
- `/skills`
- `/mcps`
- `/task`
- `/tasklist`
- `/help`

See the main README for the complete command reference.
