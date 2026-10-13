# Soak stubs — manual smoke procedure

Two standalone Node 22 servers (ESM, `node:http` only, zero npm dependencies):

| File | Purpose | Default |
| --- | --- | --- |
| `scripts/soak/stub-telegram-api.mjs` | Impersonates the Telegram Bot API | `--port 8081 --token 123:soak` |
| `scripts/soak/stub-model.mjs` | OpenAI-compatible chat completions | `--port 8090` |

Run every command below from the repository root.

### Quoting JSON on the command line

PowerShell re-quotes arguments that contain spaces and mangles embedded quotes, so pick one of
these three forms (all verified on Windows PowerShell 5.1):

1. **Inline, escaped, and with no space inside the JSON** (used by most examples below):

   ```powershell
   curl.exe -s -X POST "$tg/sendMessage" -d '{\"chat_id\":42,\"text\":\"hello\"}'
   ```

2. **Inline with spaces** — use the stop-parsing operator and a literal URL (no `$vars`, and no
   PowerShell redirection on the same line — everything after `--%` goes to curl):

   ```powershell
   curl.exe --% -s -X POST http://127.0.0.1:8081/bot123:soak/sendMessage -H "Content-Type: application/json" -d "{\"chat_id\":42,\"text\":\"hello soak\"}"
   ```

3. **From a file** — works in every shell:

   ```powershell
   '{"chat_id":42,"text":"hello soak"}' | Set-Content "$smoke\req.json" -Encoding ascii -NoNewline
   curl.exe -s -X POST "$tg/sendMessage" -H "Content-Type: application/json" --data-binary "@$smoke\req.json"
   ```

In `cmd` or bash, plain `'{"a":1}'` works everywhere.

Logs default to `scripts/soak/logs/` (the `logs/` pattern is git-ignored). The examples below
pass `--log`/`--updates` into a temp folder so the repo stays clean.

```powershell
$smoke = "$env:TEMP\opencode\soak-smoke"
New-Item -ItemType Directory -Force -Path $smoke | Out-Null
```

## 1. Syntax check

```powershell
node --check scripts\soak\stub-telegram-api.mjs   # silent = OK
node --check scripts\soak\stub-model.mjs          # silent = OK
```

## 2. Start the servers

```powershell
# Terminal A — Telegram stub
node scripts\soak\stub-telegram-api.mjs --port 8081 --token 123:soak `
  --log "$smoke\telegram-api.jsonl" --updates "$smoke\updates.jsonl"

# Terminal B — model stub
node scripts\soak\stub-model.mjs --port 8090 --tokens 120 --delay-ms 25 --tool-prob 0.35 `
  --log "$smoke\model-api.jsonl"
```

Expected startup output:

```text
[stub-telegram-api] listening on http://127.0.0.1:8081
[stub-telegram-api] token=123:soak
...
[stub-model] listening on http://127.0.0.1:8090
[stub-model] tokens=120 delayMs=25 toolProb=0.35 (tool call every 3)
```

Environment variables work as well: `STUB_TELEGRAM_PORT`, `STUB_TELEGRAM_TOKEN`,
`STUB_TELEGRAM_LOG`, `STUB_TELEGRAM_UPDATES`, `STUB_TELEGRAM_HOST`, `STUB_MODEL_PORT`,
`STUB_MODEL_LOG`, `STUB_MODEL_TOKENS`, `STUB_MODEL_DELAY_MS`, `STUB_MODEL_TOOL_PROB`,
`STUB_MODEL_HOST`. Flags win over environment variables.

Starting a second instance on a busy port must fail loudly:

```powershell
node scripts\soak\stub-telegram-api.mjs --port 8081
# [stub-telegram-api] port 8081 is already in use; stop the other process or pass --port
$LASTEXITCODE   # 1
```

## 3. Telegram stub

```powershell
$tg = "http://127.0.0.1:8081/bot123:soak"
```

### 3.1 Identity, auth, method routing

```powershell
curl.exe -s -X POST "$tg/getMe"
```

```json
{"ok":true,"result":{"id":777000001,"is_bot":true,"first_name":"SoakBot","username":"soak_test_bot","can_join_groups":true,"can_read_all_group_messages":false,"supports_inline_queries":false,"has_topics_enabled":true,"allows_users_to_create_topics":true}}
```

```powershell
curl.exe -s -X POST "http://127.0.0.1:8081/botWRONG/getMe"
# HTTP 404 -> {"ok":false,"error_code":404,"description":"Not Found"}

curl.exe -s -X POST "$tg/notAMethod"
# HTTP 400 -> {"ok":false,"error_code":400,"description":"Unsupported method"}

curl.exe -s -X POST "$tg/getWebhookInfo"   # {"ok":true,"result":{"url":""}}
curl.exe -s -X POST "$tg/deleteWebhook"    # {"ok":true,"result":true}
curl.exe -s -X POST "$tg/setMyCommands"    # {"ok":true,"result":true}
```

`GET` works too: `curl.exe -s "$tg/getMe"`.

### 3.2 Message echo, thread ids, drafts

```powershell
curl.exe -s -X POST "$tg/sendMessage" -d '{\"chat_id\":42,\"message_thread_id\":10000,\"text\":\"hello\"}'
```

```json
{"ok":true,"result":{"message_id":1,"date":1791864826,"chat":{"id":42,"type":"private"},"text":"hello","message_thread_id":10000}}
```

`message_id` auto-increments per call. `chat` falls back to `{"id":1,"type":"private"}` when the
request carries neither `chat` nor `chat_id`.

```powershell
curl.exe -s -X POST "$tg/editMessageText" -d '{\"chat_id\":42,\"message_id\":1,\"text\":\"edited\"}'
# {"ok":true,"result":{"message_id":1,"chat":{"id":42},"date":...,"text":"edited"}}

curl.exe -s -X POST "$tg/sendMessageDraft" -d '{\"chat_id\":42,\"draft_id\":\"d-77\",\"text\":\"draft1\"}'
# result carries "draft_id":"d-77" plus message_id/chat/date

curl.exe -s -X POST "$tg/sendRichMessageDraft" -d '{\"chat_id\":42,\"draft_id\":\"d-88\"}'
```

These two draft methods are the ones the soak driver later "stops"; both are recorded in
`/__state` under `drafts` with `{chat_id, draft_id, message_id, method, received_at}`.

### 3.3 Forum topics

```powershell
curl.exe -s -X POST "$tg/createForumTopic" -d '{\"chat_id\":42,\"name\":\"Reports\"}'
curl.exe -s -X POST "$tg/createForumTopic" -d '{\"chat_id\":42,\"name\":\"Reports\"}'
```

Both calls return the same id:

```json
{"ok":true,"result":{"message_thread_id":10001,"name":"Reports","icon_color":13337712}}
```

Ids start at `10000`, one per distinct `name`, and are persisted to
`<logdir>/forum-topics.json`, so a restart keeps them.

`deleteForumTopic` removes the name→id mapping (and persists it), so the next
`createForumTopic` with that name gets a fresh id: a deleted topic is gone, as
on real Telegram. It answers `note: "topic-deleted:<id>"`, or
`topic-deleted:<id>:absent` when there was nothing to delete.

```powershell
curl.exe -s -X POST "$tg/deleteForumTopic" -d '{\"chat_id\":42,\"message_thread_id\":10001}'
# {"ok":true,"result":true}          (note: topic-deleted:10001)

curl.exe -s -X POST "$tg/deleteForumTopic" -d '{\"chat_id\":42,\"message_thread_id\":10001}'
# {"ok":true,"result":true}          (note: topic-deleted:10001:absent)

curl.exe -s -X POST "$tg/createForumTopic" -d '{\"chat_id\":42,\"name\":\"Reports\"}'
# {"ok":true,"result":{"message_thread_id":10002,"name":"Reports","icon_color":13337712}}  fresh id
```

### 3.4 `getUpdates` — long poll, append, offset

Empty queue first (there must be no pending line in the updates file):

```powershell
$u = "$tg/getUpdates"
curl.exe -s -o - -w "`ntime_total=%{time_total}s" "$u?timeout=2"
```

```text
{"ok":true,"result":[]}
time_total=2.008188s
```

Append one raw update (one JSON object per line, `update_id` optional — the stub assigns ids
from `1000000`):

```powershell
'{"message":{"message_id":1,"date":1791865400,"chat":{"id":42,"type":"private"},"text":"driver appended"}}' |
  Add-Content "$smoke\updates.jsonl"
curl.exe -s "$u?timeout=1"
```

```json
{"ok":true,"result":[{"message":{"message_id":1,"date":1791865400,"chat":{"id":42,"type":"private"},"text":"driver appended"},"update_id":1000000}]}
```

Returns immediately — no wait when the queue is non-empty.

Append **while** a long poll is already waiting: the second call must come back right after the
append instead of running out its timeout.

```powershell
$job = Start-Job -ScriptBlock {
  param($url)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $body = curl.exe -s $url
  $sw.Stop()
  "elapsed=$([math]::Round($sw.Elapsed.TotalSeconds,2))s body=$body"
} -ArgumentList "$u?timeout=10"
Start-Sleep -Milliseconds 600
'{"message":{"message_id":2,"date":1791865401,"chat":{"id":42,"type":"private"},"text":"second"}}' |
  Add-Content "$smoke\updates.jsonl"
Receive-Job $job -Wait
```

```text
elapsed=0.36s body={"ok":true,"result":[{... "update_id":1000001}]}
```

`offset` discards everything below it and never repeats an update:

```powershell
'{"update_id":555000,"message":{"message_id":3,"date":1791865402,"chat":{"id":42,"type":"private"},"text":"old"}}' | Add-Content "$smoke\updates.jsonl"
'{"update_id":555001,"message":{"message_id":4,"date":1791865403,"chat":{"id":42,"type":"private"},"text":"new"}}' | Add-Content "$smoke\updates.jsonl"
curl.exe -s -X POST "$u" -d '{\"offset\":555001}'
# {"ok":true,"result":[{"update_id":555001,"message":{"message_id":4,...,"text":"new"}}]}

curl.exe -s -X POST "$u" -d '{\"offset\":555001}'
# {"ok":true,"result":[]}
```

Timeouts are capped at 50 s: `curl.exe -s "$u?timeout=600"` returns `{"ok":true,"result":[]}` after
~50 s, not 600.

### 3.5 Driver helpers and log

```powershell
curl.exe -s http://127.0.0.1:8081/__state
```

```json
{"port":8081,"threads":{"Reports":10001},"drafts":[{"chat_id":42,"draft_id":"d-77","message_id":3,"method":"sendMessageDraft","received_at":"2026-10-13T04:15:51.962Z"}],"messages":{"1":"edited"},"counters":{"sendMessage":9,"getUpdates":5},"updates":{"path":"...updates.jsonl","pending":0,"position":4,"lines":4,"badLines":0,"nextUpdateId":1000002}}
```

```powershell
curl.exe -s -X POST http://127.0.0.1:8081/__reset    # {"ok":true}
curl.exe -s http://127.0.0.1:8081/__state            # messages + counters cleared, threads + drafts + update position kept
curl.exe -s http://127.0.0.1:8081/health              # {"status":"ok"}
```

Request log (one JSON line per `/bot<token>/<method>` call; driver helpers are skipped on purpose):

```powershell
Get-Content "$smoke\telegram-api.jsonl" -Tail 3
```

```text
{"ts":"2026-10-13T04:27:08.856Z","method":"getUpdates","ok":true,"note":"update:1000000"}
{"ts":"2026-10-13T04:27:57.031Z","method":"getUpdates","ok":true,"note":"update:none"}
{"ts":"2026-10-13T04:28:26.767Z","method":"sendMessage","ok":true,"note":"msg:12"}
```

`note` markers: `draft:<id>`, `update:<first id>`, `topic:<id>`, `topic-deleted:<id>`, `msg:<id>`, `edit:<id>`,
`unsupported`, `error:<message>`.

## 4. Model stub

```powershell
$ai = "http://127.0.0.1:8090"
curl.exe -s "$ai/health"     # {"status":"ok"}
curl.exe -s "$ai/v1/models"  # {"object":"list","data":[{"id":"soak-model","object":"model","created":1,"owned_by":"soak"}]}
curl.exe -s "$ai/models"     # same body (alias)
```

### 4.1 Tool-call probe → non-streaming `tool_calls`

```powershell
curl.exe -s -X POST "$ai/v1/chat/completions" -H "Content-Type: application/json" `
  -d '{\"model\":\"soak-model\",\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"tool_call_probe\",\"parameters\":{\"type\":\"object\"}}}],\"tool_choice\":\"auto\"}'
```

```json
{"id":"chatcmpl-...","object":"chat.completion","created":...,"model":"soak-model","choices":[{"index":0,"message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_probe_1","type":"function","function":{"name":"tool_call_probe","arguments":"{}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}
```

Same result when `tool_choice` is anything other than `"auto"`/`"none"` (e.g. `"required"`), and
the probe answer is **never** streamed even if `stream:true` is set.

### 4.2 Plain completion (JSON)

```powershell
curl.exe -s -X POST "$ai/v1/chat/completions" -H "Content-Type: application/json" `
  -d '{\"model\":\"soak-model\",\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}'
# finish_reason "stop", content "reply-<n> ..." (120 words with --tokens 120), usage.completion_tokens 120
```

A malformed or empty body still answers `HTTP 200` with the same valid shape (never crashes):

```powershell
curl.exe -s -o - -w " [http=%{http_code}]" -X POST "$ai/v1/chat/completions" --data-binary "@$smoke\malformed.json"
# ... "finish_reason":"stop"}... [http=200]
```

### 4.3 Streaming (SSE)

```powershell
curl.exe --% -s -N -X POST http://127.0.0.1:8090/v1/chat/completions -H "Content-Type: application/json" -d "{\"model\":\"soak-model\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"stream me\"}]}"
```

```text
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":...,"model":"soak-model","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk",...,"delta":{"content":"reply-<n> ..."},"finish_reason":null}}

data: {"id":"chatcmpl-...",...,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

Whole stream ≈ `ceil(tokens/8) * delay-ms` (≈0.5 s with the defaults) and it is hard-capped at
30 s: `--delay-ms 5000 --tokens 1200` still finishes under 30 s.

Deterministic tool call: with `--tool-prob 0.35` every **3rd** chat request (counters include
probe requests) carries a `read_file` tool call after ~1/3 of the text:

```text
data: {...,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"README.md\"}"}}]},"finish_reason":null}}
data: {...,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}}]},"finish_reason":null}}
```

Consumers append `arguments` fragments, so the trailing empty fragment leaves the JSON intact.

### 4.4 State and log

```powershell
curl.exe -s "$ai/__state"        # {"requests":10,"streams":4,"toolCalls":1,"lastBody":"{...}"}
curl.exe -s -X POST "$ai/__reset" # {"ok":true} — counters back to 0
Get-Content "$smoke\model-api.jsonl" -Tail 3
```

```text
{"ts":"2026-10-13T04:23:07.998Z","kind":"chat","stream":true,"toolProbe":false,"tokens":120,"tool":true}
{"ts":"2026-10-13T04:23:08.496Z","kind":"chat","stream":true,"toolProbe":false,"tokens":120,"tool":false}
{"ts":"2026-10-13T04:24:43.294Z","kind":"reset","stream":false,"toolProbe":false,"tokens":0}
```

`GET /__state` is the only endpoint not logged (the driver polls it).

## 5. Shutdown

On Linux/macOS:

```bash
kill -TERM <pid>   # prints "<name> SIGTERM received, shutting down", then exits 0
```

On **Windows** the OS cannot deliver `SIGTERM`/`SIGINT` to a process you did not signal from its
own console — `Stop-Process`, `taskkill` and `child.kill("SIGTERM")` all hard-terminate the
process (Node reports `exit code=null signal=SIGTERM`, handler bypassed). The handler itself can
still be exercised in-process:

```powershell
# temp file, e.g. $smoke\wrapper.mjs — pass flags after the wrapper path
@"
await import("file:///C:/Users/Admin/oct/opencode-telegram-bot/scripts/soak/stub-telegram-api.mjs");
setTimeout(() => { console.log("[wrapper] emitting SIGTERM"); process.emit("SIGTERM"); }, 1000);
"@ | Set-Content "$smoke\wrapper.mjs"

node "$smoke\wrapper.mjs" --port 8099 --log "$smoke\shutdown.jsonl"
```

```text
[stub-telegram-api] listening on http://127.0.0.1:8099
[wrapper] emitting SIGTERM
[stub-telegram-api] SIGTERM received, shutting down
# exit code 0
```

Pressing `Ctrl+C` in the stub's own terminal delivers a real `SIGINT` and takes the same path.

## 6. Robustness checks worth repeating

- Malformed JSON body → `HTTP 200` with a minimal valid result (Telegram) or completion (model).
- Killing the client in the middle of a long poll (`poll.kill()` while `getUpdates` waits) → the
  stub keeps answering (`getMe` returns in <50 ms, no `uncaughtException` in the log).
- Unknown token → `404`; unknown method → `400`; both keep the server alive.
- Restart the Telegram stub after a run: `forum-topics.json` restores the same thread ids, and a
  re-read of `updates.jsonl` continues from the byte offset where it stopped.
