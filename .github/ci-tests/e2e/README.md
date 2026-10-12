# Telegram Web end-to-end checks

This directory contains the manual, browser-driven regression harness for testing the real Bot through Telegram Web. It validates the user-visible flow, where unit tests cannot confirm Telegram's actual message/topic navigation and keyboard behavior. It uses Playwright through the project's manual-test workflow; it does not use MTProto.

## Files and state

| Path | Purpose |
|---|---|
| .env.example | Safe template for test-only Telegram and OpenCode settings |
| run-test-bot.sh / run-test-bot.ps1 | Build and launch an isolated test Bot |
| stop-test-bot.sh / stop-test-bot.ps1 | Stop only processes started by this test harness |
| probes.js | Telegram Web DOM probes and selector discovery |
| scenarios/ | Repeatable smoke and runner lifecycle procedures |
| .tmp/e2e/home/ | Isolated settings and logs created during a run |
| .tmp/e2e/browser-profile/ | Persistent Telegram Web login profile |
| .tmp/e2e/output/ | Screenshots and console evidence |

Generated .tmp/e2e state is test data and should not be committed.

## One-time setup

1. Create a separate Telegram bot with @BotFather. Never use the production bot token; a test run creates sessions and changes projects.
2. Run the launch script once to create .env from .env.example. Set TELEGRAM_BOT_TOKEN and TELEGRAM_USER_ID, then launch again.
3. Keep BOT_LOCALE=en while using the supplied probes because they match English UI text.
4. Log into https://web.telegram.org/k/ using the persistent Playwright browser profile. Keep the Telegram Web UI in English. Only one process may use the profile at a time.
5. If your test account or bot differs from the checked-in test fixture, update the peer ID in the test configuration used by your manual-testing workflow.

The scripts must be launched from this directory:

~~~bash
./run-test-bot.sh
./stop-test-bot.sh
~~~

On Windows, use run-test-bot.ps1 and stop-test-bot.ps1. Launch builds first and stops on compilation errors. Use --skip-build only when the dist output is known to match the source being tested.

The test Bot uses isolated state under .tmp/e2e/home and defaults to an OpenCode port separate from the usual local port. Its .env, settings, logs, and processes do not share the regular development home.

## Scenario order

Run scenarios/smoke.md before checking a feature. The smoke scenario covers the basic Bot interaction loop. Run scenarios/runner-lifecycle.md once per physical test session when using GitHub Runner Lab. Keep larger feature checks in separate scenario files so their expected behavior is reviewable.

If testing on GitHub Runner Lab, check its lifecycle before starting:

~~~bash
./scripts/agent-run.sh status
~~~

Only run a long scenario when the report says SAFE. CAUTION permits bounded smoke checks. CHECKPOINT_REQUIRED, HANDOFF_IMMINENT, and HANDOFF_DUE mean stop before starting.

## Browser maintenance and cleanup

Telegram Web changes DOM selectors. If a probe stops locating UI, run discoverSelectors in probes.js against the live test chat and update the confirmed selectors. Do not hard-code a different peer ID into the shared probes.

Stop the test Bot when finished. The stop script is scoped to the test OpenCode port and PIDs recorded under the isolated test home.

For product behavior and the separation between Bot UI, Control Plane, Worker, and Core, see the repository root README. The test descriptions are behavior contracts; they intentionally do not dictate the implementation.
