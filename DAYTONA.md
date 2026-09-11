# Daytona development deployment

Daytona is supported as a development/long-running sandbox without changing the Railway deployment path.

## Storage layout

Keep the Git checkout, `node_modules`, build output, process files, and high-churn logs on Daytona's local sandbox filesystem:

- `/home/daytona/app` — Git checkout and development workspace
- `/home/daytona/.npm-global` — pinned OpenCode CLI
- `/home/daytona/.run/opencode-telegram-bot` — local launcher PID/lock files
- `/home/daytona/.logs/opencode-telegram-bot` — local bot/OpenCode logs

Mount a Daytona Volume at `/data` and keep durable bot-owned state under:

- `/data/opencode-telegram-bot` — `.env`, `app-state.json`, memory/topic state and integration configuration

Do **not** clone a Git repository into `/data`. Daytona Volumes are S3/FUSE-backed and may not implement `rename(2)`, which Git requires. `daytona-start.sh` loads `daytona-fs-compat.mjs` only for the Daytona Node process so the bot's atomic JSON file updates can fall back to copy+unlink when a filesystem explicitly rejects rename. Railway does not load this shim.

## First-time sandbox setup

Create/mount the volume when the sandbox is created. Example:

```bash
daytona create --name opencode-bot --target eu --auto-stop 0 --auto-delete -1 --volume "Bot volume:/data"
```

Clone the repository to the local sandbox disk:

```bash
daytona exec opencode-bot -- sh -lc 'cd /home/daytona && git clone https://github.com/aminsh35322088-ctrl/opencode-telegram-bot.git app'
```

Create `/data/opencode-telegram-bot/.env` with at least:

```dotenv
TELEGRAM_BOT_TOKEN=your-development-bot-token
TELEGRAM_ALLOWED_USER_ID=your-telegram-user-id
```

Use a separate Telegram bot token for Daytona while Railway is running. Two long-polling instances using the same bot token will conflict.

## Redeploy

The redeploy script protects local development work. It refuses to continue if the Git working tree is dirty, fetches `origin/main`, performs only a fast-forward update, installs exact npm dependencies, builds TypeScript, installs the OpenCode version pinned in `.opencode-version` if needed, and restarts the bot. The script re-executes itself from a stable local copy before updating Git, so a pull cannot change deployment logic mid-run.

From a machine with the Daytona CLI authenticated:

```bash
daytona exec opencode-bot -- /home/daytona/app/daytona-redeploy.sh
```

For a development branch, set `DAYTONA_GIT_BRANCH` in the command environment or switch the checkout and invoke the script with that variable set.

Set `DAYTONA_RUN_LINT=1` to make a redeploy run ESLint before restarting.

## Lifecycle

Daytona container sandboxes preserve their local filesystem across stop/start, but running processes are cleared on stop. A mounted Daytona Volume persists independently of the sandbox. After manually stopping/starting the sandbox, run `daytona-redeploy.sh` again to relaunch the bot.
