# Soak harness

Isolated stress/soak environment for the real Bot. It exists so the
stabilization gates in `docs/SOAK_GATES.md` can be **executed** instead of
asserted.

## What it runs

```
driver.mjs ──appends raw updates──▶ stub-telegram-api.mjs ◀── HTTP ── real Bot (dist/index.js)
     │                                   ▲                                     │
     │                                   │                                     ▼
     └── reads /__state ─────────────────┘                          opencode serve ──▶ stub-model.mjs
```

- **`stub-telegram-api.mjs`** impersonates `api.telegram.org`. The Bot dials it
  because `TELEGRAM_API_ROOT` is set (see `src/config.ts`). It answers `getMe`,
  `getWebhookInfo`, `deleteWebhook`, long-polling `getUpdates`, `sendMessage`,
  `sendMessageDraft`/`sendRichMessageDraft`, `editMessage*`, `deleteMessage`,
  `createForumTopic`, `answerCallbackQuery`, `pinChatMessage`, `getFile`, … and
  exposes `GET /__state` for the driver to observe drafts/messages/threads.
- **`stub-model.mjs`** is an OpenAI-compatible endpoint (`/v1/models`,
  `/v1/chat/completions`) with deterministic SSE streaming and tool calls.
- **`seed-state.mjs`** writes `$OPENCODE_TELEGRAM_HOME/app-state.json` with a
  custom provider pointing at that stub and selects it.
- **`driver.mjs`** injects raw updates (including `stopped_message_generation`),
  waits for observable outcomes, enforces the registered deadlines D1–D7 and
  appends evidence.
- **`run.sh`** orchestrates the whole run into one directory and tears it down.
- **`persist-evidence.sh`** pushes `evidence/` to the `soak-evidence` branch so a
  crash or runner handoff cannot erase what was already observed.

## Credentials and network

No Telegram token, no `TELEGRAM_USER_ID` belonging to a real account, no
`RAILWAY_API_TOKEN`, no `api.telegram.org`, no model credentials. The Bot token
is the dummy `123:soak`; the user id is `SOAK_USER_ID` (default `987654321`).

`CONTROL_APPLICATION_IPC` and `RAILWAY_API_TOKEN` are unset, so the Bot runs in
local mode: it never consults the Control Plane, never provisions a Worker and
never reaches Railway. **The harness cannot touch the production Worker or any
active Topic, and it adds no paid resources.**

## Running

On a Linux host with Node 22:

```bash
npm ci
node scripts/verify-core-install.mjs
node scripts/materialize-core-release.mjs   # .core/bin/opencode, sha256 verified
node scripts/verify-core-install.mjs --runtime
npm run build

scripts/soak/run.sh smoke                    # boot + /start + New Chat
scripts/soak/run.sh cycle                    # one full W1..W6 cycle
scripts/soak/run.sh stress 7200              # 2 h stress
```

Or trigger the `Soak` workflow (`workflow_dispatch`) which does all of the above
on `ubuntu-24.04` and uploads the evidence as an artifact plus pushes it to the
`soak-evidence` branch.

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `SOAK_TELEGRAM_PORT` | `8081` | local Bot API stub |
| `SOAK_MODEL_PORT` | `8090` | local model stub |
| `SOAK_USER_ID` | `987654321` | the "owner" user id the Bot accepts |
| `SOAK_TOKEN` | `123:soak` | dummy Bot token |
| `SOAK_SEED_VERIFIED` | `true` | seed `toolCallVerified`; set `false` to make the Bot run its real tool-call probe against the stub |
| `SOAK_PERSIST` | `1` | push evidence periodically during the run |
| `SOAK_PERSIST_INTERVAL` | `300` | seconds between evidence pushes |
| `SOAK_RUN_DIR` | `soak-runs/<stamp>-<stage>` | run directory |

## Evidence layout

```
soak-runs/<stamp>-<stage>/
  bot.log                    full Bot log
  telegram-api.jsonl         every stub Bot API call
  model-api.jsonl            every stub model call
  persist.log                evidence push attempts
  evidence/
    cycles.jsonl             one line per flow step: pass / fail / not-executed
    resource-samples.jsonl   RSS, process count, loadavg per cycle
    summary.json             stage totals
    processes.txt            process tree after the run
    telegram-state.json      final stub state
    model-state.json         final stub model counters
    runner-identity.txt      host, sha, cpus, memory (CI)
```

## What this does and does not prove

**Proves:** the Bot's real update path, session/run lifecycle, streaming,
tool execution, native Stop attribution, Delete Chat cleanup, and resource
behaviour under sustained load — end to end, for hours, reproducibly.

**Does not prove:** anything that only exists on real Telegram or real Railway.
Stub evidence never substitutes for real Telegram/Railway evidence, and those
rows in `SOAK_GATES.md` stay `PENDING` until they are exercised for real.

A flow that cannot be observed is recorded `not-executed`, never as a pass, and
an interrupted run is recorded as interrupted — runner termination is not test
completion.
