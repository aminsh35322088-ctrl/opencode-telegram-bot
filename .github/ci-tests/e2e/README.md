# Browser-driven e2e checks

Drives the real bot through Telegram Web with Playwright MCP — no MTProto, no API
credentials. A persistent browser profile keeps the web session logged in.

Run these checks with the project's manual-testing agent/workflow when available. If no dedicated subagent is present in the current checkout, follow this document directly; the scenarios under `scenarios/` are the source of truth for repeatable physical checks.

## Files

| Path | What it is |
| --- | --- |
| `.env` | Test config you edit. Copied into the test home on every launch |
| `.env.example` | Template |
| `run-test-bot.ps1` / `.sh` | Starts the bot against an isolated home |
| `stop-test-bot.ps1` / `.sh` | Stops the test bot and its OpenCode server |
| `probes.js` | DOM probes and confirmed Telegram Web selectors |
| `scenarios/` | Regression scenarios the subagent runs before any feature check |
| `.tmp/e2e/home/` | Runtime state: `settings.json`, `logs/` |
| `.tmp/e2e/browser-profile/` | Persistent Telegram Web login |
| `.tmp/e2e/output/` | Screenshots and console logs the subagent produces |

## One-time setup

1. **Test bot.** Create a separate bot with @BotFather. Do not use your
   production token — these runs create sessions and switch projects.

2. **Config.** Run `.\e2e\run-test-bot.ps1` once; it creates `e2e/.env` from the
   template and exits. Fill in `TELEGRAM_BOT_TOKEN` and
   `TELEGRAM_ALLOWED_USER_ID`, then run it again.

   Keep `BOT_LOCALE=en` — the probes match bot strings literally.

3. **Browser session.** The Playwright MCP server is declared inside the
   subagent, so the browser only exists while the subagent runs. Ask it to open
   `https://web.telegram.org/k/`, then scan the QR code from your phone once.
   Keep the Telegram Web interface in English. The session survives restarts;
   re-login is needed only every few months.

   Only one process at a time may use the browser profile. If a browser is
   already open on it, the subagent will fail with a profile-lock error.

4. **Update the peer id if your manual-testing harness uses one.** The Telegram Web
   chat is identified by `data-peer-id`. If you use a different test bot, update
   the peer id in the active manual-testing harness/configuration for your checkout.
   Do not rely on a hard-coded path to an optional subagent file.

## GitHub Runner Lab preflight

If the physical Telegram test is running on `GitHub-Runner-Lab`, runner lifetime is part of the test setup.

Before launching the test bot:

```bash
# Run from the GitHub-Runner-Lab repository
./scripts/agent-run.sh status
```

The report must include `RUNTIME_STATE` and `REMAINING_MINUTES`.

- `SAFE`: normal physical testing is allowed.
- `CAUTION`: only bounded smoke checks; do not start a long scenario.
- `CHECKPOINT_REQUIRED`, `HANDOFF_IMMINENT`, or `HANDOFF_DUE`: stop before launching a new test, push durable work, checkpoint, and move to the successor runner.

Once per physical-test session on the Lab, run the non-destructive [runner lifecycle scenario](./scenarios/runner-lifecycle.md). Do **not** modify the live lifecycle clock just to force warning states during a bot test.

## Running

```powershell
.\e2e\run-test-bot.ps1                # Windows
```

```bash
./e2e/run-test-bot.sh                 # macOS / Linux
```

It builds first and refuses to start on a compile error. Add `-SkipBuild` /
`--skip-build` only when you know `dist/` is already current — the subagent never
does, since it is called right after the code changed.

Everything stays inside `.tmp/e2e/home`, so your real `.env`, `settings.json`
and `logs/` are untouched. Logs land in `.tmp/e2e/home/logs/`, one file per
launch.

OpenCode runs on the port from `OPENCODE_API_URL` in `e2e/.env` (4097 by
default) so test runs never collide with your own OpenCode on 4096.

When done:

```powershell
.\e2e\stop-test-bot.ps1               # Windows
```

```bash
./e2e/stop-test-bot.sh                # macOS / Linux
```

The subagent runs this itself at the end of every session. It only stops what
the test setup started: the OpenCode server on the configured test port, and
bot processes whose pid appears in a `.tmp/e2e/home/logs` file name.

The `.sh` scripts need the executable bit once they are committed:
`git update-index --chmod=+x e2e/run-test-bot.sh e2e/stop-test-bot.sh`

## Maintenance

Telegram Web changes class names between releases. When probes stop matching,
run the `discoverSelectors` probe from `probes.js` against a live chat and fix
the constants there. The selectors were last calibrated on 2026-07-27.

`@playwright/mcp` is pinned in the subagent's `mcpServers` frontmatter because a
newer release may require a newer Chromium revision than the one installed
locally. The browser config (profile path, viewport, output dir) lives there
too — there is no `.mcp.json` in this project.

## What to test

`scenarios/` holds the regression scenarios. The subagent runs them before any
feature check, so a change that breaks the basic loop is caught before anything
else is judged. `smoke.md` covers the basic bot regression loop. When testing on GitHub Runner Lab, also run [`runner-lifecycle.md`](./scenarios/runner-lifecycle.md) once per physical-test session. Longer feature scenarios belong in separate files next to them.

The feature scenario itself is passed to the subagent per task, as behaviour
only: it gets no diff and no implementation detail, and writes its own cases.
Commands, features, and interaction routing rules are documented in
[`PRODUCT.md`](../../../PRODUCT.md).
